import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createLogger } from "@repo/logger";
import type { SessionInfo, PaneInfo, WindowInfo } from "@repo/protocol";
import { config } from "./config.js";

const execFileAsyncRaw = promisify(execFile);
const logger = createLogger("relay:tmux");

const TMUX_TIMEOUT = 10_000;

// Node's default stdout cap for execFile is 1 MiB, and exceeding it rejects with
// ERR_CHILD_PROCESS_STDIO_MAXBUFFER instead of truncating. A pane capture on a
// host with a large `history-limit` blows straight past that (32 MB observed),
// which used to abort session attach entirely. Captures are bounded below, so
// this is only a backstop — but it applies to every tmux call, and list-sessions
// on a very busy server can get large too.
const TMUX_MAX_BUFFER = 16 * 1024 * 1024;

// Default number of scrollback lines replayed to a client on attach. Enough to
// fill any realistic viewport plus scroll history, small enough to send and
// render in one paint.
const DEFAULT_CAPTURE_LINES = 2000;

export interface CaptureOptions {
  /** Scrollback lines to include, counting back from the bottom. */
  lines?: number;
  /** Include SGR escape sequences so colours survive the replay. */
  escapes?: boolean;
}

function execFileAsync(cmd: string, args: string[]) {
  return execFileAsyncRaw(cmd, args, {
    timeout: TMUX_TIMEOUT,
    maxBuffer: TMUX_MAX_BUFFER,
  });
}

/** Shared argv builder for the two capture-pane entry points. */
function captureArgs(
  target: string,
  lines: number,
  escapes: boolean,
): string[] {
  return [
    ...tmuxArgs(),
    "capture-pane",
    "-t",
    target,
    "-p",
    ...(escapes ? ["-e"] : []),
    "-S",
    `-${lines}`,
  ];
}

function tmuxArgs(): string[] {
  return config.tmuxSocket ? ["-S", config.tmuxSocket] : [];
}

export async function listSessions(): Promise<SessionInfo[]> {
  try {
    const { stdout } = await execFileAsync("tmux", [
      ...tmuxArgs(),
      "list-sessions",
      "-F",
      "#{session_name}\t#{session_id}\t#{session_windows}\t#{session_attached}\t#{session_created}\t#{session_activity}\t#{window_width}\t#{window_height}",
    ]);

    return stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [name, id, windows, attached, created, activity, width, height] =
          line.split("\t");
        return {
          name: name!,
          id: id!,
          windows: parseInt(windows!, 10),
          attached: attached === "1",
          created: new Date(parseInt(created!, 10) * 1000).toISOString(),
          activity: new Date(parseInt(activity!, 10) * 1000).toISOString(),
          dimensions:
            width && height
              ? { cols: parseInt(width, 10), rows: parseInt(height, 10) }
              : undefined,
        };
      });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("no server running") || msg.includes("no sessions")) {
      return [];
    }
    logger.error({ err: e }, "Failed to list sessions");
    throw e;
  }
}

export async function createSession(
  name?: string,
  cwd?: string,
  command?: string,
): Promise<SessionInfo> {
  const args = [
    ...tmuxArgs(),
    "new-session",
    "-d",
    "-P",
    "-F",
    "#{session_name}\t#{session_id}",
  ];

  if (name) args.push("-s", name);
  if (cwd) args.push("-c", cwd);
  if (command) {
    args.push(command);
  } else {
    args.push(config.tmuxDefaultShell);
  }

  const { stdout } = await execFileAsync("tmux", args);
  const [sessionName, sessionId] = stdout.trim().split("\t");

  logger.info({ sessionName }, "Created session");

  return {
    name: sessionName!,
    id: sessionId!,
    windows: 1,
    attached: false,
    created: new Date().toISOString(),
    activity: new Date().toISOString(),
  };
}

export async function killSession(name: string): Promise<void> {
  await execFileAsync("tmux", [...tmuxArgs(), "kill-session", "-t", name]);
  logger.info({ name }, "Killed session");
}

export async function renameSession(
  oldName: string,
  newName: string,
): Promise<void> {
  await execFileAsync("tmux", [
    ...tmuxArgs(),
    "rename-session",
    "-t",
    oldName,
    newName,
  ]);
  logger.info({ oldName, newName }, "Renamed session");
}

export async function sessionExists(name: string): Promise<boolean> {
  try {
    await execFileAsync("tmux", [...tmuxArgs(), "has-session", "-t", name]);
    return true;
  } catch {
    return false;
  }
}

export async function sendKeys(session: string, keys: string): Promise<void> {
  await execFileAsync("tmux", [
    ...tmuxArgs(),
    "send-keys",
    "-t",
    session,
    keys,
    "Enter",
  ]);
}

export async function sendInterrupt(session: string): Promise<void> {
  await execFileAsync("tmux", [
    ...tmuxArgs(),
    "send-keys",
    "-t",
    session,
    "C-c",
  ]);
}

/**
 * Capture a session's visible pane plus bounded scrollback, for replay into a
 * freshly attached client. Colours are kept — this is written straight into
 * xterm.js.
 */
export async function capturePane(
  session: string,
  opts: CaptureOptions = {},
): Promise<string> {
  const { stdout } = await execFileAsync(
    "tmux",
    captureArgs(
      session,
      opts.lines ?? DEFAULT_CAPTURE_LINES,
      opts.escapes ?? true,
    ),
  );
  return stdout;
}

export async function listWindows(session: string): Promise<WindowInfo[]> {
  try {
    const { stdout } = await execFileAsync("tmux", [
      ...tmuxArgs(),
      "list-windows",
      "-t",
      session,
      "-F",
      "#{window_id}\t#{window_index}\t#{window_name}\t#{window_active}\t#{window_panes}\t#{window_layout}\t#{window_width}\t#{window_height}\t#{window_activity_flag}",
    ]);

    return stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [
          id,
          index,
          name,
          active,
          paneCount,
          layout,
          width,
          height,
          activity,
        ] = line.split("\t");
        return {
          id: id!,
          index: parseInt(index!, 10),
          name: name!,
          active: active === "1",
          paneCount: parseInt(paneCount!, 10),
          layout: layout!,
          activity: activity === "1",
          dimensions:
            width && height
              ? { cols: parseInt(width, 10), rows: parseInt(height, 10) }
              : undefined,
        };
      });
  } catch (e) {
    logger.error({ err: e }, "Failed to list windows");
    throw e;
  }
}

/**
 * The id of the window the session is currently showing.
 *
 * This is asked of tmux directly rather than inferred from `#{pane_active}` in
 * a pane listing: `pane_active` is scoped to its own window, so a session with
 * N windows has N panes flagged active and picking "the first one" silently
 * means "window 1", whatever the user is actually looking at.
 */
export async function currentWindowId(session: string): Promise<string> {
  const { stdout } = await execFileAsync("tmux", [
    ...tmuxArgs(),
    "display-message",
    "-p",
    "-t",
    session,
    "#{window_id}",
  ]);
  return stdout.trim();
}

/** Step to the next (`delta >= 0`) or previous window, wrapping. */
export async function stepWindow(
  session: string,
  delta: number,
): Promise<void> {
  await execFileAsync("tmux", [
    ...tmuxArgs(),
    delta >= 0 ? "next-window" : "previous-window",
    "-t",
    session,
  ]);
  logger.info({ session, delta }, "Stepped window");
}

// `select-pane -Z` (tmux >= 3.1) keeps the window zoomed across the selection.
// Without it the only way to move between panes of a zoomed window is
// unzoom -> select -> rezoom, which flickers and, if the selection lands
// somewhere unexpected, rezooms the wrong pane. Probed once and cached.
let selectPaneSupportsZ: boolean | undefined;

async function supportsSelectPaneZ(): Promise<boolean> {
  if (selectPaneSupportsZ !== undefined) return selectPaneSupportsZ;
  try {
    const { stdout } = await execFileAsync("tmux", [
      ...tmuxArgs(),
      "list-commands",
      "select-pane",
    ]);
    selectPaneSupportsZ = /-[A-Za-z]*Z/.test(stdout);
  } catch {
    selectPaneSupportsZ = false;
  }
  return selectPaneSupportsZ;
}

/** Test seam: reset the cached `select-pane -Z` probe. */
export function resetSelectPaneZProbe(): void {
  selectPaneSupportsZ = undefined;
}

/**
 * Step to the next/previous pane within the session's current window.
 *
 * `:.+` / `:.-` are tmux's own relative pane targets, so this never races a
 * pane list the client fetched a moment ago. On a tmux without `-Z` the caller
 * loses zoom across the step, which is the pre-existing behaviour.
 */
export async function stepPane(session: string, delta: number): Promise<void> {
  const target = `${session}:.${delta >= 0 ? "+" : "-"}`;
  const args = [...tmuxArgs(), "select-pane"];
  if (await supportsSelectPaneZ()) args.push("-Z");
  args.push("-t", target);
  await execFileAsync("tmux", args);
  logger.info({ session, delta }, "Stepped pane");
}

export async function listPanes(
  session: string,
  windowId?: string,
): Promise<PaneInfo[]> {
  try {
    const args = [...tmuxArgs(), "list-panes"];
    if (windowId) {
      args.push("-t", `${session}:${windowId}`);
    } else {
      // -s = list all panes across all windows in the session
      args.push("-s", "-t", session);
    }
    args.push(
      "-F",
      "#{pane_id}\t#{pane_index}\t#{window_id}\t#{pane_active}\t#{window_zoomed_flag}\t#{pane_width}\t#{pane_height}\t#{pane_left}\t#{pane_top}\t#{pane_current_command}\t#{pane_current_path}",
    );
    const { stdout } = await execFileAsync("tmux", args);

    return stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [
          id,
          index,
          winId,
          active,
          zoomed,
          width,
          height,
          left,
          top,
          command,
          path,
        ] = line.split("\t");
        return {
          id: id!,
          index: parseInt(index!, 10),
          windowId: winId!,
          active: active === "1",
          // `window_zoomed_flag` is a property of the WINDOW, not the pane —
          // every pane in a zoomed window reports it. The pane that is actually
          // filling the window is the active one, so both must hold.
          zoomed: zoomed === "1" && active === "1",
          dimensions: {
            cols: parseInt(width!, 10),
            rows: parseInt(height!, 10),
          },
          position: {
            x: parseInt(left!, 10),
            y: parseInt(top!, 10),
          },
          command: command || undefined,
          path: path || undefined,
        };
      });
  } catch (e) {
    logger.error({ err: e }, "Failed to list panes");
    throw e;
  }
}

/**
 * Capture a single pane by id, for the copy-mode overlay. Escapes are OFF by
 * default here: this content is shown as selectable plain text and copied to
 * the clipboard, so SGR sequences would be pasted verbatim.
 */
export async function capturePaneById(
  paneId: string,
  opts: CaptureOptions = {},
): Promise<string> {
  const { stdout } = await execFileAsync(
    "tmux",
    captureArgs(
      paneId,
      opts.lines ?? DEFAULT_CAPTURE_LINES,
      opts.escapes ?? false,
    ),
  );
  return stdout;
}

export async function splitPane(
  session: string,
  direction: "h" | "v",
): Promise<void> {
  await execFileAsync("tmux", [
    ...tmuxArgs(),
    "split-window",
    "-t",
    session,
    `-${direction}`,
  ]);
  logger.info({ session, direction }, "Split pane");
}

export async function selectPane(paneId: string): Promise<void> {
  // `-Z` "keeps the window zoomed if it was zoomed" — it never zooms a window
  // that was not. That is exactly the semantics every caller wanted, and it
  // replaces the unzoom/select/rezoom triple the clients used to send.
  const args = [...tmuxArgs(), "select-pane"];
  if (await supportsSelectPaneZ()) args.push("-Z");
  args.push("-t", paneId);
  await execFileAsync("tmux", args);
  logger.info({ paneId }, "Selected pane");
}

/**
 * Zoom a pane, or unzoom the window, idempotently.
 *
 * tmux has no "set zoom to X" — `resize-pane -Z` is a toggle and nothing else.
 * A toggle is the wrong primitive to hand a network client: two taps that
 * arrive before the layout announcement does apply twice and leave the user
 * looking at the opposite of the button they pressed. So the desired state is
 * read first and the toggle is sent only when it would change something.
 *
 * The three-way branch is not defensive padding; each arm is a state tmux can
 * actually be in, and they need different commands:
 *
 *   - not zoomed, want zoomed      → `resize-pane -Z`, which also activates it
 *   - zoomed on another pane       → `select-pane -Z`, which *moves* the zoom
 *   - zoomed, want it gone         → `resize-pane -Z` again
 *
 * The middle one is the one a toggle can never express. Without it, asking to
 * zoom pane B while pane A is zoomed unzooms the window, because the only
 * thing a toggle can do to a zoomed window is un-zoom it.
 *
 * `desired` omitted keeps the old toggle, for a client that predates the
 * field. `paneId` omitted targets the session's current pane, likewise.
 */
export async function zoomPane(
  session: string,
  opts: { paneId?: string; desired?: boolean } = {},
): Promise<void> {
  const target = opts.paneId ?? session;

  if (opts.desired === undefined) {
    await execFileAsync("tmux", [
      ...tmuxArgs(),
      "resize-pane",
      "-t",
      target,
      "-Z",
    ]);
    logger.info({ session, target }, "Toggled pane zoom");
    return;
  }

  const { stdout } = await execFileAsync("tmux", [
    ...tmuxArgs(),
    "display-message",
    "-p",
    "-t",
    target,
    "#{window_zoomed_flag}\t#{pane_active}",
  ]);
  const [flag, active] = stdout.trim().split("\t");
  const windowZoomed = flag === "1";
  // `window_zoomed_flag` is a property of the window: every pane in a zoomed
  // window reports it. The pane actually *being* zoomed is the active one —
  // the same reading `listPanes` uses.
  const thisPaneZoomed = windowZoomed && active === "1";

  if (opts.desired === thisPaneZoomed) {
    logger.debug({ session, target }, "Pane zoom already as asked");
    return;
  }

  const args =
    opts.desired && windowZoomed
      ? ["select-pane", "-Z", "-t", target]
      : ["resize-pane", "-t", target, "-Z"];
  await execFileAsync("tmux", [...tmuxArgs(), ...args]);
  logger.info({ session, target, zoomed: opts.desired }, "Set pane zoom");
}

export async function resizePane(
  paneId: string,
  direction: "U" | "D" | "L" | "R",
  amount: number,
): Promise<void> {
  await execFileAsync("tmux", [
    ...tmuxArgs(),
    "resize-pane",
    "-t",
    paneId,
    `-${direction}`,
    String(amount),
  ]);
  logger.info({ paneId, direction, amount }, "Resized pane");
}

export async function killPane(paneId: string): Promise<void> {
  await execFileAsync("tmux", [...tmuxArgs(), "kill-pane", "-t", paneId]);
  logger.info({ paneId }, "Killed pane");
}

export async function createWindow(
  session: string,
  name?: string,
): Promise<void> {
  const args = [...tmuxArgs(), "new-window", "-t", session];
  if (name) args.push("-n", name);
  args.push(config.tmuxDefaultShell);
  await execFileAsync("tmux", args);
  logger.info({ session, name }, "Created window");
}

export async function selectWindow(windowId: string): Promise<void> {
  await execFileAsync("tmux", [...tmuxArgs(), "select-window", "-t", windowId]);
  logger.info({ windowId }, "Selected window");
}

export async function killWindow(windowId: string): Promise<void> {
  await execFileAsync("tmux", [...tmuxArgs(), "kill-window", "-t", windowId]);
  logger.info({ windowId }, "Killed window");
}

export async function swapPane(
  paneId: string,
  direction: "U" | "D" | "L" | "R",
): Promise<void> {
  await execFileAsync("tmux", [
    ...tmuxArgs(),
    "swap-pane",
    "-t",
    paneId,
    `-${direction}`,
  ]);
  logger.info({ paneId, direction }, "Swapped pane");
}

export async function renameWindow(
  windowId: string,
  name: string,
): Promise<void> {
  await execFileAsync("tmux", [
    ...tmuxArgs(),
    "rename-window",
    "-t",
    windowId,
    name,
  ]);
  logger.info({ windowId, name }, "Renamed window");
}

export async function selectLayout(
  session: string,
  preset: string,
): Promise<void> {
  await execFileAsync("tmux", [
    ...tmuxArgs(),
    "select-layout",
    "-t",
    session,
    preset,
  ]);
  logger.info({ session, preset }, "Selected layout");
}

export async function rotateLayout(session: string): Promise<void> {
  await execFileAsync("tmux", [...tmuxArgs(), "rotate-window", "-t", session]);
  logger.info({ session }, "Rotated layout");
}

export async function sendPrefix(session: string): Promise<void> {
  await execFileAsync("tmux", [...tmuxArgs(), "send-prefix", "-t", session]);
  logger.info({ session }, "Sent prefix");
}

export async function enterCopyMode(session: string): Promise<void> {
  await execFileAsync("tmux", [...tmuxArgs(), "copy-mode", "-t", session]);
  logger.info({ session }, "Entered copy mode");
}

/** Whether the session's active pane is currently in copy mode. */
export async function isInCopyMode(session: string): Promise<boolean> {
  return (await readScrollState(session)).inMode;
}

/** Where the session's active pane sits in its history. */
export interface ScrollState {
  /** Lines scrolled back from the live output; 0 is the bottom. */
  position: number;
  /** Lines of history above the visible rows. */
  historySize: number;
  paneHeight: number;
  inMode: boolean;
}

/**
 * Read the pane's scroll position, history size and copy-mode flag at once.
 *
 * One `display-message` rather than one per field, because every one of these
 * costs a process spawn and this is read on a drag. `scroll_position` is empty
 * outside copy mode — tmux only tracks it there — which is not missing data:
 * a pane that is not in copy mode is showing live output, i.e. position 0.
 */
export async function readScrollState(session: string): Promise<ScrollState> {
  const { stdout } = await execFileAsync("tmux", [
    ...tmuxArgs(),
    "display-message",
    "-p",
    "-t",
    session,
    "#{pane_in_mode}\t#{scroll_position}\t#{history_size}\t#{pane_height}",
  ]);
  const [inMode, position, historySize, paneHeight] = stdout.trim().split("\t");
  const num = (value: string | undefined): number => {
    const parsed = Number.parseInt(value ?? "", 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  };
  return {
    inMode: inMode === "1",
    position: num(position),
    historySize: num(historySize),
    paneHeight: num(paneHeight),
  };
}

/**
 * Scroll the session's active pane through its history.
 *
 * Positive `lines` goes back into the past. This has to happen here rather
 * than in the browser: `attachSession` runs a real `tmux attach-session`, so
 * tmux owns the alternate screen and the client's own scrollback is always
 * empty — the history only exists inside tmux, reachable only from copy mode.
 *
 * Entering copy mode is conditional so a drag that emits several of these does
 * not restart the view at the bottom on every one; `-e` means tmux leaves copy
 * mode by itself once the user scrolls back to the live output, which is the
 * behaviour a scroll gesture should have.
 *
 * Returns where the pane ended up, so the caller can tell the client without
 * paying for a second round of `tmux` spawns.
 */
export async function scrollHistory(
  session: string,
  lines: number,
): Promise<ScrollState> {
  const count = Math.trunc(lines);
  if (count === 0) return readScrollState(session);
  const before = await readScrollState(session);
  if (!before.inMode) {
    await execFileAsync("tmux", [
      ...tmuxArgs(),
      "copy-mode",
      "-e",
      "-t",
      session,
    ]);
  }
  await execFileAsync("tmux", [
    ...tmuxArgs(),
    "send-keys",
    "-t",
    session,
    "-X",
    "-N",
    String(Math.abs(count)),
    count > 0 ? "scroll-up" : "scroll-down",
  ]);
  return readScrollState(session);
}

/**
 * Put the view at an absolute point in the history, `position` lines back from
 * the live output.
 *
 * The delta is computed here, against the position tmux reports right now,
 * rather than on the client: a scrollbar drag names a destination, and output
 * arriving mid-drag moves everything underneath a client-computed delta.
 */
export async function scrollToPosition(
  session: string,
  position: number,
): Promise<ScrollState> {
  const target = Math.max(0, Math.trunc(position));
  const state = await readScrollState(session);
  const clamped = Math.min(target, state.historySize);
  const delta = clamped - (state.inMode ? state.position : 0);
  if (delta === 0) return state;
  return scrollHistory(session, delta);
}

/**
 * Leave copy mode, whether or not we are in it.
 *
 * `cancel` outside copy mode is not an error in tmux, but the check is cheap
 * and keeps a stray call from being logged as one.
 */
export async function exitCopyMode(session: string): Promise<void> {
  if (!(await isInCopyMode(session))) return;
  await execFileAsync("tmux", [
    ...tmuxArgs(),
    "send-keys",
    "-t",
    session,
    "-X",
    "cancel",
  ]);
  logger.info({ session }, "Left copy mode");
}
