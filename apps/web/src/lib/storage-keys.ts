import { localToken } from "./unlocked";

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
 * Zustand's persisted stores (`ccremote-terminal`, `ccremote-commands`, …) are
 * deliberately *not* renamed. Their names are invisible, and changing one makes
 * `persist` look in a key that does not exist, silently resetting somebody's
 * font size and command history to defaults. A cosmetic rename is not worth
 * that; they can move whenever those stores next take a schema version.
 */

export const TOKEN_KEY = "tmuxde-token";
export const LAST_SESSION_KEY = "tmuxde-last-session";

/**
 * Set by the dashboard's "New session", read and cleared by the terminal.
 *
 * `sessionStorage`, not `localStorage`: it is a one-shot instruction for the
 * next navigation, and a stale copy of it would pop a dialog at someone who
 * opened the terminal a week later. Creating a session needs a live relay
 * connection, which the dashboard does not have and the terminal does — so the
 * dashboard's job is to say what to do on arrival, not to do it.
 */
export const OPEN_NEW_SESSION_KEY = "tmuxde-open-new-session";

/**
 * The first-run checklist, and the second-credential banner, once dismissed.
 *
 * `localStorage`, per browser, and that is semantically right rather than a
 * shortcut: step 3 of the checklist is "pair *this* browser", which is a fact
 * about this browser and nothing else. Putting it on the account would hide the
 * checklist on a new phone that has never paired — the exact device that needs
 * it most.
 *
 * Not in `LEGACY`: they never had an old spelling, and a missing key already
 * means "not dismissed", which is the safe default.
 */
export const ONBOARDING_DISMISSED_KEY = "tmuxde-onboarding-dismissed";
export const SECOND_CREDENTIAL_DISMISSED_KEY = "tmuxde-second-credential-dismissed";

/**
 * Set by sign-up, read by the dashboard.
 *
 * Someone who signs up in the middle of the CLI device flow is redirected
 * straight back into it and may not see the dashboard for days. This survives
 * that detour so the checklist still greets them on their first visit rather
 * than being computed away by state that has moved on.
 */
export const ONBOARDING_STARTED_KEY = "tmuxde-onboarding-started";

/** The signed-out account pitch in the terminal settings panel, once hidden. */
export const ACCOUNT_NUDGE_DISMISSED_KEY = "tmuxde-account-nudge-dismissed";

const LEGACY = {
  [TOKEN_KEY]: "ccremote-token",
  [LAST_SESSION_KEY]: "ccremote-last-session",
} as const;

/**
 * Read a key, adopting the legacy value if that is all there is.
 *
 * Safe to call during render: it touches localStorage only in the browser and
 * returns null everywhere else.
 */
export function readStored(key: string): string | null {
  if (typeof window === "undefined") return null;

  const current = localStorage.getItem(key);
  if (current !== null) return current;

  const legacyKey = LEGACY[key as keyof typeof LEGACY];
  if (!legacyKey) return null;

  const legacy = localStorage.getItem(legacyKey);
  if (legacy === null) return null;

  // Promote once, then forget the old name.
  localStorage.setItem(key, legacy);
  localStorage.removeItem(legacyKey);
  return legacy;
}

export function writeStored(key: string, value: string): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(key, value);
}

/** Clears both spellings, so a sign-out cannot leave a legacy key behind. */
export function clearStored(key: string): void {
  if (typeof window === "undefined") return;
  localStorage.removeItem(key);
  const legacyKey = LEGACY[key as keyof typeof LEGACY];
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
 * Synchronous on purpose: `getFileDownloadUrl()` builds a `?token=` URL during
 * render and cannot await.
 */
export function readSelfHostedToken(): string | null {
  return localToken() ?? readStored(TOKEN_KEY);
}
