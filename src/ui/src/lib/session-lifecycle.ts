import type { SessionInfo } from "@/protocol";
import {
  believedInCopyMode,
  noteEnteredCopyMode,
  noteLeftCopyMode,
} from "@/lib/copy-mode-belief";
import {
  LAST_SESSION_KEY,
  clearStored,
  readStored,
  writeStored,
} from "@/lib/storage-keys";
import { usePaneStore } from "@/stores/pane-store";
import { useSessionStore } from "@/stores/session-store";
import { useSessionTreeStore } from "@/stores/session-tree-store";

/**
 * Sessions that end or change name under the browser.
 *
 * tmux owns sessions, so a kill, an exit or a rename can come from this
 * browser, another one, or a shell on the machine. The browser hears of it
 * through `session:killed`, `session:exited`, a `session:list`, or the
 * `SESSION_NOT_FOUND` answer to an attach. All of them land here, so the
 * active session, the last session kept in localStorage and the `/s/` URL
 * agree about what still exists.
 *
 * Getting this wrong left a killed session selected. The layout restored it
 * from localStorage whenever nothing was active, the attach failed, and the
 * terminal sat on the dead session's last screen.
 */

/** Renames this tab followed, old name to newest name. */
const renamed = new Map<string, string>();

/** Names that are gone. A deep link to one goes back to `/`. */
const gone = new Set<string>();

/**
 * How long `NOT_ATTACHED` answers stay quiet after a failed attach.
 *
 * The attach goes out with `pane:list`, `window:list` and a scroll state ask
 * behind it. When the session is gone the relay refuses the attach and then
 * answers each of those with `NOT_ATTACHED`, in order, right away. Those
 * three answers explain nothing the first one did not.
 */
const ATTACH_FALLOUT_MS = 3000;
let falloutUntil = 0;

/** `Session "<name>" not found`, as both relays word it. */
export function sessionNotFoundText(name: string): string {
  return `Session "${name}" not found`;
}

/**
 * Sessions that kept their tmux id under a new name, as `[from, to]`.
 *
 * tmux ids (`$3`) stay with a session for the life of the server, whatever it
 * is called. A name missing from `next` whose id shows up there under a name
 * `prev` did not have was renamed.
 */
export function findRenames(
  prev: SessionInfo[],
  next: SessionInfo[],
): [string, string][] {
  const prevNames = new Set(prev.map((s) => s.name));
  const nextNames = new Set(next.map((s) => s.name));
  const fresh = new Map<string, string>();
  for (const s of next) {
    if (s.id && !prevNames.has(s.name)) fresh.set(s.id, s.name);
  }
  const out: [string, string][] = [];
  for (const s of prev) {
    if (!s.id || nextNames.has(s.name)) continue;
    const to = fresh.get(s.id);
    if (to === undefined) continue;
    fresh.delete(s.id);
    out.push([s.name, to]);
  }
  return out;
}

/** Apply a `session:list`, following any rename it shows. */
export function applySessionList(sessions: SessionInfo[]): void {
  const prev = useSessionStore.getState().sessions;
  for (const [from, to] of findRenames(prev, sessions)) {
    followRename(from, to);
  }
  for (const s of sessions) {
    gone.delete(s.name);
    // The name belongs to a live session again, not to the renamed one.
    renamed.delete(s.name);
  }
  useSessionStore.getState().setSessions(sessions);
}

/** Apply a `session:created`. A name can come back after it was gone. */
export function noteSessionCreated(session: SessionInfo): void {
  gone.delete(session.name);
  renamed.delete(session.name);
  useSessionStore.getState().addSession(session);
}

/**
 * Move everything this tab keeps under `from` over to `to`.
 *
 * The active session changes name, so the terminal attaches again under the
 * new one. That is also what moves the relay's own record of the attach: the
 * Node relay keeps the old name until then.
 */
export function followRename(from: string, to: string): void {
  if (from === to) return;
  renamed.set(from, to);
  for (const [old, current] of renamed) {
    if (current === from) renamed.set(old, to);
  }
  renamed.delete(to);
  gone.delete(to);
  useSessionStore.getState().renameSession(from, to);
  useSessionTreeStore.getState().forget(from);
  if (readStored(LAST_SESSION_KEY) === from) writeStored(LAST_SESSION_KEY, to);
  // Copy mode belongs to the pane, and the pane did not move.
  if (believedInCopyMode(from)) {
    noteLeftCopyMode(from);
    noteEnteredCopyMode(to);
  }
}

/**
 * Drop a session that no longer exists.
 *
 * The active session falls back to another one this tab opened, or to none.
 * The last session in localStorage follows, so a reload does not try the
 * dead one again.
 */
export function forgetSession(name: string): void {
  gone.add(name);
  renamed.delete(name);
  const tree = useSessionTreeStore.getState();
  const wasAttached = tree.attachedSession === name;
  useSessionStore.getState().removeSession(name);
  tree.forget(name);
  if (wasAttached) {
    tree.setAttachedSession(null);
    // The panes on screen belong to the dead session. The Files view and
    // the Changes badge read the active pane from here.
    usePaneStore.getState().clearAll();
  }
  noteLeftCopyMode(name);
  const next = useSessionStore.getState().activeSessionId;
  if (readStored(LAST_SESSION_KEY) === name) {
    if (next) writeStored(LAST_SESSION_KEY, next);
    else clearStored(LAST_SESSION_KEY);
  }
}

/**
 * The relay refused to attach `name` because it does not exist.
 *
 * The relay detaches before it looks the session up, so this connection is
 * attached to nothing now.
 */
export function forgetMissingSession(name: string): void {
  falloutUntil = Date.now() + ATTACH_FALLOUT_MS;
  forgetSession(name);
  const tree = useSessionTreeStore.getState();
  if (tree.attachedSession !== null) {
    tree.setAttachedSession(null);
    usePaneStore.getState().clearAll();
  }
}

/** Whether an error is one of the expected answers after a failed attach. */
export function isAttachFallout(code: string): boolean {
  return code === "NOT_ATTACHED" && Date.now() < falloutUntil;
}

/**
 * Whether `session:exited` for `name` is the echo of a rename this tab
 * already followed. The Node relay's monitor reads a rename as an exit of
 * the old name plus a new session. The session did not end.
 */
export function isRenamedAway(name: string): boolean {
  return renamed.has(name);
}

/** The name a renamed session has now, or null when it was not renamed. */
export function renamedTo(name: string): string | null {
  return renamed.get(name) ?? null;
}

/** Whether a session this tab knew of is gone. */
export function isGone(name: string): boolean {
  return gone.has(name);
}

/** Test seam: module state outlives a test otherwise. */
export function resetSessionLifecycle(): void {
  renamed.clear();
  gone.clear();
  falloutUntil = 0;
}

export const resetSessionLifecycleForTests = resetSessionLifecycle;
