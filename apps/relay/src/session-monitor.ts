import type { SessionInfo, WindowInfo } from "@repo/protocol";
import { createLogger } from "@repo/logger";
import { listSessions, listWindows } from "./tmux-manager.js";

const logger = createLogger("relay:monitor");

export interface SessionMonitor {
  start(): void;
  stop(): void;
  onSessionExit(cb: (name: string) => void): void;
  onSessionCreated(cb: (session: SessionInfo) => void): void;
  onSessionActivity(cb: (name: string, activity: string) => void): void;
  onWindowsChanged(cb: (name: string, windows: WindowInfo[]) => void): void;
}

export interface SessionMonitorOptions {
  /**
   * Sessions worth polling for window changes — in practice, the ones some
   * browser is attached to. A window created, renamed, killed or selected in
   * the user's own terminal is otherwise invisible to the web client until it
   * re-attaches, because nothing in the PTY byte stream names it.
   */
  watchedSessions?: () => string[];
}

/**
 * Cheap change detector for a window list.
 *
 * Every field here is one the client draws, and the two at the end were added
 * because leaving them out made this poller blind to the whole class of change
 * that does not add or remove a window. Pressing `prefix z` in the user's own
 * terminal alters neither the window count nor the pane count, so a signature
 * built from those alone was identical before and after — which is why a pane
 * unzoomed outside the browser went on being drawn as zoomed until something
 * else happened to force a fresh listing.
 *
 * `layout` is here for the same reason and catches the rest of it: a pane
 * split, killed or dragged to a new size in another client. Note that tmux
 * reports the *unzoomed* layout while a window is zoomed, so `layout` cannot
 * stand in for `zoomed` — both are needed, and neither is redundant.
 */
function windowSignature(windows: WindowInfo[]): string {
  return windows
    .map(
      (w) =>
        `${w.id}:${w.index}:${w.name}:${w.active ? 1 : 0}:${w.paneCount}` +
        `:${w.zoomed ? 1 : 0}:${w.layout}`,
    )
    .join("|");
}

export function createSessionMonitor(
  opts: SessionMonitorOptions = {},
): SessionMonitor {
  let interval: NodeJS.Timeout | null = null;
  const knownSessions = new Set<string>();
  const exitCallbacks: Array<(name: string) => void> = [];
  const createdCallbacks: Array<(session: SessionInfo) => void> = [];
  const activityCallbacks: Array<(name: string, activity: string) => void> = [];
  const windowCallbacks: Array<(name: string, windows: WindowInfo[]) => void> =
    [];
  const windowSignatures = new Map<string, string>();

  async function pollWindows() {
    const watched = opts.watchedSessions?.() ?? [];
    const watching = new Set(watched);
    for (const name of windowSignatures.keys()) {
      if (!watching.has(name)) windowSignatures.delete(name);
    }
    for (const name of watching) {
      try {
        const windows = await listWindows(name);
        const sig = windowSignature(windows);
        const previous = windowSignatures.get(name);
        windowSignatures.set(name, sig);
        // First sighting only seeds the baseline: the client already fetched
        // its own list on attach, so re-announcing it is pure noise.
        if (previous === undefined || previous === sig) continue;
        for (const cb of windowCallbacks) cb(name, windows);
      } catch {
        // The session can vanish between the two polls. The exit path covers it.
        windowSignatures.delete(name);
      }
    }
  }

  async function poll() {
    try {
      const sessions = await listSessions();
      const currentNames = new Set(sessions.map((s) => s.name));

      // Detect exited sessions
      for (const name of knownSessions) {
        if (!currentNames.has(name)) {
          logger.info({ name }, "Session exited");
          for (const cb of exitCallbacks) cb(name);
          knownSessions.delete(name);
        }
      }

      // Track new and updated sessions
      for (const session of sessions) {
        if (!knownSessions.has(session.name)) {
          knownSessions.add(session.name);
          for (const cb of createdCallbacks) cb(session);
        }
        for (const cb of activityCallbacks) {
          cb(session.name, session.activity);
        }
      }
    } catch (e) {
      logger.error({ err: e }, "Session monitor poll failed");
    }

    try {
      await pollWindows();
    } catch (e) {
      logger.error({ err: e }, "Window poll failed");
    }
  }

  return {
    start() {
      poll();
      interval = setInterval(poll, 5000);
      logger.info("Session monitor started");
    },
    stop() {
      if (interval) {
        clearInterval(interval);
        interval = null;
      }
      logger.info("Session monitor stopped");
    },
    onSessionExit(cb) {
      exitCallbacks.push(cb);
    },
    onSessionCreated(cb) {
      createdCallbacks.push(cb);
    },
    onSessionActivity(cb) {
      activityCallbacks.push(cb);
    },
    onWindowsChanged(cb) {
      windowCallbacks.push(cb);
    },
  };
}
