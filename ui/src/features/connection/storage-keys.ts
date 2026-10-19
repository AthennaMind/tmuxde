import { machineId, machineStorageKey } from "./machine-context";
import { localToken } from "@/features/lock/unlocked";

/**
 * localStorage keys, and the one-time migration off the old product name.
 *
 * This app shipped as `ccremote`, then `tmuxremote`, then `mtmux`, before
 * settling on `tmuxde`. The auth token key came along for the ride, so renaming
 * it without care would sign out every existing install — the token is the only
 * thing standing between a returning user and a login screen they cannot
 * satisfy, because the token lives on a machine they may not be sitting at.
 *
 * So the rename is done with a copy-forward: read the new key, fall back to the
 * old one, and promote it on first touch. After one visit the legacy key is
 * gone and this file is the only place that remembers it existed.
 *
 * The `mtmux-*` keys have no copy-forward. That rename came with a fresh
 * deployment, so every device signs in again once.
 *
 * Zustand's persisted stores (`ccremote-commands`, …) are deliberately *not*
 * renamed. Their names are invisible, and changing one makes `persist` look in
 * a key that does not exist, silently resetting somebody's command history to
 * defaults. A cosmetic rename is not worth that. They can move whenever those
 * stores next take a schema version.
 *
 * `ccremote-settings` and `ccremote-terminal` are read once more by
 * `features/settings/settings-migration.ts`, which moves them into the synced
 * settings document and this browser's `tmuxde-device-settings`.
 */

export const TOKEN_KEY = "tmuxde-token";
export const LAST_SESSION_KEY = "tmuxde-last-session";

const LEGACY = {
  [TOKEN_KEY]: "ccremote-token",
  ...(machineId() === "local" ? { [LAST_SESSION_KEY]: "ccremote-last-session" } : {}),
} as const;

/**
 * Read a key, adopting the legacy value if that is all there is.
 *
 * Safe to call during render: it touches localStorage only in the browser and
 * returns null everywhere else.
 */
export function readStored(key: string): string | null {
  if (typeof window === "undefined") return null;

  const scoped = key === LAST_SESSION_KEY ? machineStorageKey(key) : key;
  const current = localStorage.getItem(scoped);
  if (current !== null) return current;

  const legacyKey = scoped === key ? LEGACY[key as keyof typeof LEGACY] : undefined;
  if (!legacyKey) return null;

  const legacy = localStorage.getItem(legacyKey);
  if (legacy === null) return null;

  // Promote once, then forget the old name.
  localStorage.setItem(scoped, legacy);
  localStorage.removeItem(legacyKey);
  return legacy;
}

export function writeStored(key: string, value: string): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(key === LAST_SESSION_KEY ? machineStorageKey(key) : key, value);
}

/** Clears both spellings, so a sign-out cannot leave a legacy key behind. */
export function clearStored(key: string): void {
  if (typeof window === "undefined") return;
  const scoped = key === LAST_SESSION_KEY ? machineStorageKey(key) : key;
  localStorage.removeItem(scoped);
  const legacyKey = scoped === key ? LEGACY[key as keyof typeof LEGACY] : undefined;
  if (legacyKey) localStorage.removeItem(legacyKey);
}

/**
 * The self-hosted relay token, from wherever it currently lives.
 *
 * On a device with no lock that is `localStorage`, exactly as before. Once a
 * lock is enrolled the plaintext copy is deleted and the token is held in
 * memory by `unlocked.ts` — so this is the one function every reader should
 * call, and the reason it exists rather than three `readStored(TOKEN_KEY)`
 * calls that would each have to remember the second case.
 *
 * Synchronous on purpose: the terminal layout and `getStoredToken()` read it
 * during render and cannot await.
 */
export function readSelfHostedToken(): string | null {
  return localToken() ?? readStored(TOKEN_KEY);
}
