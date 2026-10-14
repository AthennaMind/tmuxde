import { forget, isEnrolled, isUnlocked } from "./unlocked";

/**
 * Everything that has to happen when the device locks, in one place.
 *
 * Dropping the master key is necessary and not sufficient. A locked tab that
 * keeps an authenticated WebSocket open keeps a live capability — a lock-screen
 * XSS could drive it — and an xterm buffer that is merely hidden is still in
 * the DOM. So locking also disconnects and empties the stores whose contents
 * came off the machine.
 *
 * **It does not kill the tmux session.** tmux durability is the product thesis;
 * a lock that ended your work would be a worse feature than no lock.
 *
 * The reconnect path needs no new code: `TerminalView`'s status effect already
 * re-drives exactly one `session:attach` with `capture: true` when the socket
 * comes back, and `session:attach` is already in `DROP_WHEN_DISCONNECTED`. The
 * cost of locking and unlocking again is ~200–800 ms and a repaint.
 */

const CHANNEL_NAME = "tmuxde-lock";

export type LockReason = "manual" | "idle" | "background" | "other-tab";

type Disconnect = () => void;

let disconnect: Disconnect | null = null;
let channel: BroadcastChannel | null = null;
/**
 * Set for the duration of any WebAuthn ceremony.
 *
 * iOS fires `visibilitychange` for the Face ID prompt itself, so without this
 * a lock-on-background device would lock the instant you tried to unlock it —
 * an unwinnable loop.
 */
let ceremonyDepth = 0;

/**
 * Let the app hand in the one side effect this module cannot reach on its own.
 *
 * The socket lives in a hook; importing it here would be a cycle, and a lock
 * module that depends on the terminal is backwards.
 */
export function registerDisconnect(fn: Disconnect | null): void {
  disconnect = fn;
}

export function duringCeremony<T>(run: () => Promise<T>): Promise<T> {
  ceremonyDepth += 1;
  return run().finally(() => {
    // A short tail, because the visibility event for dismissing the system
    // sheet arrives after the promise settles.
    setTimeout(() => {
      ceremonyDepth = Math.max(0, ceremonyDepth - 1);
    }, 1500);
  });
}

export function ceremonyInProgress(): boolean {
  return ceremonyDepth > 0;
}

export function lockNow(reason: LockReason = "manual"): void {
  if (!isEnrolled() || !isUnlocked()) return;

  // Disconnect before wiping, so nothing queued on the socket goes out after
  // the token and keys are gone.
  try {
    disconnect?.();
  } catch {
    // A socket that was already gone.
  }
  forget();

  // Lock propagates to the other tabs; **unlock never does.** Broadcasting an
  // unlock would mean one successful PIN entry silently unlocking a tab on
  // another screen, and the master key must never leave this module in any
  // case.
  if (reason !== "other-tab") post();
}

function post(): void {
  try {
    ensureChannel()?.postMessage({ type: "lock" });
  } catch {
    // No BroadcastChannel. Each tab still locks on its own triggers.
  }
}

function ensureChannel(): BroadcastChannel | null {
  if (typeof window === "undefined" || !("BroadcastChannel" in window)) {
    return null;
  }
  channel ??= new BroadcastChannel(CHANNEL_NAME);
  return channel;
}

/** Listen for a lock in another tab. Returns an unsubscribe. */
export function listenForCrossTabLock(): () => void {
  const bc = ensureChannel();
  if (!bc) return () => {};
  const onMessage = (event: MessageEvent) => {
    if ((event.data as { type?: string } | null)?.type === "lock") {
      lockNow("other-tab");
    }
  };
  bc.addEventListener("message", onMessage);
  return () => bc.removeEventListener("message", onMessage);
}
