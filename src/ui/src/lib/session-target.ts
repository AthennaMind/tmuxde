import type { ClientMessage } from "@/protocol";
import { getRelayClient } from "@/hooks/use-websocket";
import { LAST_SESSION_KEY, writeStored } from "@/lib/storage-keys";
import { useSessionStore } from "@/stores/session-store";
import { useSessionTreeStore } from "@/stores/session-tree-store";

/**
 * Commands for a session that may not be attached yet.
 *
 * The server only accepts window and pane ids from the attached session (see
 * `owned` in `internal/node/local/router.go`). A click on a window of another
 * session has to attach first and select second. The commands wait here until
 * the server confirms the attach with `session:attached`.
 */
const PENDING_TIMEOUT_MS = 10_000;

let pending: {
  session: string;
  messages: ClientMessage[];
  expires: number;
} | null = null;

/** Send now when `session` is attached, otherwise attach and send after. */
export function runInSession(
  session: string,
  messages: ClientMessage[],
): boolean {
  const client = getRelayClient();
  if (!client || client.status !== "connected") return false;
  if (useSessionTreeStore.getState().attachedSession === session) {
    pending = null;
    for (const message of messages) client.send(message);
    return true;
  }
  pending = messages.length
    ? { session, messages, expires: Date.now() + PENDING_TIMEOUT_MS }
    : null;
  useSessionStore.getState().setActiveSession(session);
  writeStored(LAST_SESSION_KEY, session);
  return true;
}

/** Called for every `session:attached`. */
export function noteSessionAttached(name: string): void {
  useSessionTreeStore.getState().setAttachedSession(name);
  const queued = pending;
  if (!queued || queued.session !== name) return;
  pending = null;
  if (Date.now() > queued.expires) return;
  const client = getRelayClient();
  if (!client || client.status !== "connected") return;
  for (const message of queued.messages) client.send(message);
}

/**
 * Called when the terminal sends `session:detach`, on unmount or when no
 * session is picked. Queued commands stay: a remount attaches again and
 * sends them.
 */
export function noteDetachSent(): void {
  useSessionTreeStore.getState().setAttachedSession(null);
}

/** Called when the socket drops. A new socket starts unattached. */
export function noteSessionDetached(): void {
  pending = null;
  useSessionTreeStore.getState().setAttachedSession(null);
}

const lastRequest = new Map<string, number>();

/**
 * Ask for a session's windows and panes.
 *
 * `minInterval` throttles callers driven by activity, which arrives on every
 * burst of output from a busy session.
 */
export function requestSessionDetails(name: string, minInterval = 0): void {
  const now = Date.now();
  if (minInterval > 0 && now - (lastRequest.get(name) ?? 0) < minInterval)
    return;
  const client = getRelayClient();
  if (!client || client.status !== "connected") return;
  lastRequest.set(name, now);
  const store = useSessionTreeStore.getState();
  if (!store.details[name]) store.setLoading(name, true);
  client.send({ type: "session:windows", name });
}
