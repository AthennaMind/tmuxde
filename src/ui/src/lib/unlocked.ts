import { wipe } from "@/crypto";

/**
 * The only place an unlocked master key exists.
 *
 * ## Why a module variable and not storage
 *
 * Two properties fall out of this being a plain module-level binding, and
 * neither is enforced by any code — they are structural, which is the only
 * kind of guarantee worth having here:
 *
 * 1. **A cold load is always locked.** A module variable does not survive a
 *    reload. Nothing has to remember to clear it, and no bug can leave it
 *    behind.
 * 2. **Synchronous reads work.** The terminal layout and `getStoredToken()`
 *    read the token during render and cannot await. Holding it in memory
 *    satisfies that without persisting anything.
 *
 * ## What cannot be wiped
 *
 * `wipe()` zero-fills the `Uint8Array`s. The `directToken` is a JavaScript
 * **string**, and strings are immutable — there is no way to scrub one from the
 * heap. Dropping the reference is the whole of what can be done, and a heap
 * snapshot taken before GC will still contain it. Saying so here rather than
 * implying otherwise.
 */

export type UnlockedKeys = {
  c2s: Uint8Array;
  s2c: Uint8Array;
  confirm: Uint8Array;
  directToken: string;
  /**
   * Sessions the user asked to be re-prompted for, by name.
   *
   * Kept in here rather than anywhere readable because the *list* is the
   * sensitive part: an attacker holding a locked device should not be able to
   * read off which sessions were worth protecting.
   */
  sessionLocks?: Record<string, true>;
};

export type LockState = {
  /** A lock is enrolled on this device. */
  enrolled: boolean;
  /** The master key is in memory. Meaningless unless `enrolled`. */
  unlocked: boolean;
};

let masterKeyRef: Uint8Array | null = null;
let enrolledRef = false;
/**
 * The self-hosted path's `tmuxde-token`, once a lock has taken it out of
 * `localStorage`.
 *
 * It has to be readable synchronously, since `getStoredToken()` runs during
 * render. A module variable gives that without persisting anything.
 */
let localTokenRef: string | null = null;
/** Decrypted per-server keys, keyed by serverId. Never persisted. */
const keys = new Map<string, UnlockedKeys>();
const listeners = new Set<(state: LockState) => void>();

function snapshot(): LockState {
  return { enrolled: enrolledRef, unlocked: masterKeyRef !== null };
}

function announce(): void {
  const state = snapshot();
  for (const listener of listeners) {
    try {
      listener(state);
    } catch {
      // One bad subscriber must not stop the others from locking.
    }
  }
}

export function subscribeLock(fn: (state: LockState) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function lockState(): LockState {
  return snapshot();
}

export function isUnlocked(): boolean {
  return masterKeyRef !== null;
}

/**
 * True when this device has a lock set up at all.
 *
 * Set once at boot from the lock record in IndexedDB. A device with no lock is
 * the default and the entire self-hosted path — nothing about this feature may
 * become a requirement.
 */
export function isEnrolled(): boolean {
  return enrolledRef;
}

export function setEnrolled(enrolled: boolean): void {
  if (enrolledRef === enrolled) return;
  enrolledRef = enrolled;
  announce();
}

export function masterKey(): Uint8Array | null {
  return masterKeyRef;
}

/** Hand over the master key after a successful unlock or a fresh enrollment. */
export function setMasterKey(mk: Uint8Array): void {
  if (masterKeyRef && masterKeyRef !== mk) wipe(masterKeyRef);
  masterKeyRef = mk;
  enrolledRef = true;
  announce();
}

export function cacheKeys(serverId: string, unlocked: UnlockedKeys): void {
  keys.set(serverId, unlocked);
}

export function setLocalToken(token: string | null): void {
  localTokenRef = token;
}

export function localToken(): string | null {
  return localTokenRef;
}

export function cachedKeys(serverId: string): UnlockedKeys | null {
  return keys.get(serverId) ?? null;
}

/**
 * Drop everything. Called by `lockNow()` — do not call this directly, or the
 * socket stays open and the stores keep their contents.
 */
export function forget(): void {
  if (masterKeyRef) wipe(masterKeyRef);
  masterKeyRef = null;
  localTokenRef = null;
  for (const entry of keys.values()) {
    wipe(entry.c2s, entry.s2c, entry.confirm);
  }
  keys.clear();
  announce();
}
