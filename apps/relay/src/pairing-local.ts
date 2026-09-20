import crypto from "node:crypto";
import type { GrantRecord } from "@repo/protocol";
import { isGrantActive } from "@repo/protocol";
import { FULL_GRANT } from "./grant.js";

/**
 * Tokenless sign-in for a device on the same network.
 *
 * `mtmux start` prints a QR encoding `http://<lan-ip>:<port>/login#n=<nonce>`.
 * Scanning it loads the login page, which redeems the nonce here for a scoped,
 * expiring session token. The 64-hex `AUTH_TOKEN` is never shown to the phone
 * and never typed by hand.
 *
 * Two properties carry the security argument:
 *
 *  - The nonce is single-use. A photo of the terminal taken after the first
 *    scan is worthless, and a redeemed nonce cannot be replayed.
 *  - Session tokens are held only in memory, so restarting the server revokes
 *    every device it ever paired. The CLI re-registers the ones it still
 *    trusts on the way back up; nothing else survives.
 *
 * A token's window is an *idle* one, not a countdown from issue: every
 * successful lookup re-stamps it. That distinction is the whole difference
 * between "a device you stopped using goes cold" and "a device you are using
 * right now stops working mid-afternoon". The 24 h default belongs to the
 * LAN-QR path, where a short window is the point; a device paired by code
 * carries the CLI's own peer lifetime instead, passed in as `ttlMs`.
 *
 * Both stores then mean the same thing — trusted unless idle for 90 days — but
 * only this one sees the traffic that proves a device is in use, which is what
 * `onSessionTokenUsed` exists to carry back.
 *
 * Nothing here is registered in split mode (apps/relay standalone), where no
 * nonce is ever issued — `redeemPairingNonce` then rejects unconditionally and
 * the endpoint is inert.
 */

const NONCE_TTL_MS = 15 * 60 * 1000;
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

/** Secrets are held as SHA-256 digests so a heap dump yields nothing usable. */
function digest(secret: string): string {
  return crypto.createHash("sha256").update(secret, "utf8").digest("hex");
}

type Expiring = { expiresAt: number };

/**
 * A live session token and what it may do.
 *
 * This map was `Map<sha256(token), {expiresAt}>` already, which is why scoping
 * needed no protocol change and no change to the token format: widening the
 * *value* to carry a grant is the whole mechanism. Keeping the token opaque
 * matters — a `<grantId>.<secret>` format would have to be communicated to the
 * browser somehow, and the browser derives `directToken` independently from
 * the CPace secret with no round trip to learn an id in. It would also put a
 * grant id into `/file?token=` URLs and every access log that sees them.
 */
type Session = Expiring & {
  grant: GrantRecord;
  /**
   * The idle window to re-stamp `expiresAt` with on every successful lookup.
   *
   * Held per entry rather than read from a constant because the two flows want
   * different windows: a LAN-QR token gets the short default, a device paired
   * by code gets whatever lifetime the CLI's peer record has left.
   */
  renewMs: number;
  /**
   * What to call the device holding this token, when the CLI told us.
   *
   * Display only, and self-reported by the browser at that — nothing is
   * decided by it. It exists so `mtmux start` can say "iPhone · Safari" in the
   * connected-devices line instead of counting anonymous sockets, which is the
   * difference between a number and an answer to "is that me or someone else?"
   */
  label?: string;
  /**
   * Which peer record in the CLI's config this token belongs to.
   *
   * Present only for tokens the CLI registered — the LAN-QR path has no peer
   * record to point at. It exists so `onSessionTokenUsed` can name the device
   * whose `lastSeenAt` should move forward; see that listener for why the two
   * stores have to agree.
   */
  deviceId?: string;
};

const nonces = new Map<string, Expiring>();
const sessions = new Map<string, Session>();

/**
 * Notified whenever a registered device's token is successfully used.
 *
 * This is what keeps the relay's idle window and the CLI's peer store telling
 * the same story. Both mean "trusted unless idle for 90 days", but only the
 * relay sees the traffic — a device can authenticate over the LAN a thousand
 * times without the CLI process learning anything about it. Without this the
 * CLI's `lastSeenAt` stayed pinned to the moment of pairing, so `mtmux devices`
 * called a phone in daily use stale on day 90 while the relay, whose window had
 * been sliding all along, kept letting it in.
 *
 * Fired after the renewal, so a listener that throws cannot deny access.
 */
const useListeners = new Set<(deviceId: string) => void>();

export function onSessionTokenUsed(
  listener: (deviceId: string) => void,
): () => void {
  useListeners.add(listener);
  return () => useListeners.delete(listener);
}

/**
 * Fired when a token stops being valid, so live sockets can be closed.
 *
 * Deleting the map entry only stops the *next* authentication; a socket that
 * authenticated a minute ago holds its grant in memory and keeps working, so
 * `mtmux devices revoke` reported success while the revoked device carried on.
 * Revocation that does not disconnect is not revocation.
 *
 * The payload is token ids, not the grant id: `FULL_GRANT` is one shared
 * record, so sweeping by grant id would close every connection on the machine
 * whenever any single device was revoked.
 */
export type RevocationEvent = {
  /** `digest()` of every token that just stopped being valid. */
  tokenIds: string[];
  /** The grant those tokens belonged to, when they shared one. */
  grantId: string | null;
};

const revokeListeners = new Set<(event: RevocationEvent) => void>();

export function onSessionTokenRevoked(
  listener: (event: RevocationEvent) => void,
): () => void {
  revokeListeners.add(listener);
  return () => revokeListeners.delete(listener);
}

function emitRevocation(event: RevocationEvent): void {
  if (event.tokenIds.length === 0) return;
  for (const listener of revokeListeners) {
    try {
      listener(event);
    } catch {
      // A listener that throws must never leave the token still registered.
    }
  }
}

/**
 * The id a connection records so it can be matched by a later revocation.
 *
 * Exported rather than re-implemented at the call site so there is exactly one
 * definition of "same token" in the relay.
 */
export function sessionTokenId(token: string): string {
  return digest(token);
}

/**
 * Which device a live session token belongs to, keyed by the token's id.
 *
 * The id *is* the map key — `sessionTokenId` and the internal `digest` are the
 * same function — so this is a lookup and not a scan. It exists so a caller
 * holding a connection (which carries `tokenId`, never the token itself) can
 * name the device without the raw credential ever leaving this module. Null
 * for the machine's own `AUTH_TOKEN`, which has no device behind it, and for a
 * token that has since expired.
 */
export function deviceIdForTokenId(tokenId: string): string | null {
  return sessions.get(tokenId)?.deviceId ?? null;
}

function prune(map: Map<string, Expiring>, now: number): void {
  for (const [key, entry] of map) {
    if (entry.expiresAt <= now) map.delete(key);
  }
}

/**
 * Notified whenever a nonce is successfully redeemed, so the CLI can arm a
 * fresh one and reprint the QR — otherwise the code on screen is silently dead
 * after the first device pairs.
 */
const redeemListeners = new Set<() => void>();

export function onPairingRedeemed(listener: () => void): () => void {
  redeemListeners.add(listener);
  return () => redeemListeners.delete(listener);
}

export type PairingNonce = { nonce: string; expiresAt: number };

/** Mint a nonce for the QR. Replaces any previous one — only one is live. */
export function issuePairingNonce(
  ttlMs: number = NONCE_TTL_MS,
  now: number = Date.now(),
): PairingNonce {
  nonces.clear();
  const nonce = crypto.randomBytes(16).toString("base64url");
  const expiresAt = now + ttlMs;
  nonces.set(digest(nonce), { expiresAt });
  return { nonce, expiresAt };
}

export type SessionToken = { token: string; expiresAt: number };

/**
 * Redeem a nonce for a session token, or null if it is unknown, expired, or
 * already used.
 */
export function redeemPairingNonce(
  nonce: string,
  now: number = Date.now(),
): SessionToken | null {
  prune(nonces, now);
  const key = digest(nonce);
  const entry = nonces.get(key);
  if (!entry) return null;
  // Single use: burn it whether or not the caller does anything with the token.
  nonces.delete(key);
  if (entry.expiresAt <= now) return null;
  const session = issueSessionToken(SESSION_TTL_MS, now);
  for (const listener of redeemListeners) {
    try {
      listener();
    } catch {
      // A misbehaving listener must never fail the pairing itself.
    }
  }
  return session;
}

export function issueSessionToken(
  ttlMs: number = SESSION_TTL_MS,
  now: number = Date.now(),
  grant: GrantRecord = FULL_GRANT,
): SessionToken {
  prune(sessions, now);
  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = now + ttlMs;
  sessions.set(digest(token), { expiresAt, renewMs: ttlMs, grant });
  return { token, expiresAt };
}

/**
 * Accept a session token derived elsewhere.
 *
 * `mtmux pair` runs in its own process, so the key it derives with the browser
 * is not in this one's memory. After a successful pairing it posts the derived
 * direct-path token here (over loopback, authenticated with AUTH_TOKEN) so the
 * browser can authenticate on the direct path without the long-lived token
 * ever being sent to it.
 */
export function registerSessionToken(
  token: string,
  ttlMs: number = SESSION_TTL_MS,
  now: number = Date.now(),
  grant: GrantRecord = FULL_GRANT,
  label?: string,
  deviceId?: string,
): SessionToken {
  prune(sessions, now);
  const expiresAt = now + ttlMs;
  sessions.set(digest(token), {
    expiresAt,
    renewMs: ttlMs,
    grant,
    ...(label ? { label } : {}),
    ...(deviceId ? { deviceId } : {}),
  });
  return { token, expiresAt };
}

/**
 * The display label behind a session token, if it has one.
 *
 * Separate from `grantForToken` because it is not part of any decision: a
 * caller that needs to know whether a token is good must not be able to get a
 * name back instead of an answer.
 */
export function labelForToken(
  token: string,
  now: number = Date.now(),
): string | null {
  const entry = sessions.get(digest(token));
  if (!entry || entry.expiresAt <= now) return null;
  return entry.label ?? null;
}

/**
 * The grant behind a session token, or null if there isn't a live one.
 *
 * The single lookup every caller should use. `isValidSessionToken` is kept as
 * a thin wrapper over it so nothing can accidentally answer "yes, valid"
 * without also having the scope in hand.
 */
export function grantForToken(
  token: string,
  now: number = Date.now(),
): GrantRecord | null {
  const key = digest(token);
  const entry = sessions.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= now) {
    sessions.delete(key);
    return null;
  }
  // Revocation and expiry live on the grant as well as on the map entry: a
  // grant revoked through `mtmux share revoke` must die immediately, without
  // waiting for the session token's own idle window — and it must not be kept
  // alive by the renewal below, which is why this check stays ahead of it.
  if (!isGrantActive(entry.grant, now)) {
    sessions.delete(key);
    return null;
  }
  // Sliding renewal. Without it the window is a countdown from pairing, so a
  // device in continuous use is cut off mid-session at exactly the age of its
  // token — the "I have to restart the CLI every day" failure. A token nobody
  // uses still ages out on the same schedule.
  entry.expiresAt = now + entry.renewMs;
  if (entry.deviceId) {
    for (const listener of useListeners) {
      try {
        listener(entry.deviceId);
      } catch {
        // Bookkeeping. A listener that throws must never cost a device access.
      }
    }
  }
  return entry.grant;
}

export function isValidSessionToken(
  token: string,
  now: number = Date.now(),
): boolean {
  return grantForToken(token, now) !== null;
}

/** Drop every token bound to a grant id. Used by `mtmux share revoke`. */
export function revokeGrant(grantId: string): number {
  const tokenIds: string[] = [];
  for (const [key, entry] of sessions) {
    if (entry.grant.id === grantId) {
      sessions.delete(key);
      tokenIds.push(key);
    }
  }
  emitRevocation({ tokenIds, grantId });
  return tokenIds.length;
}

export function revokeSessionToken(token: string): void {
  const key = digest(token);
  const entry = sessions.get(key);
  if (!entry) return;
  sessions.delete(key);
  emitRevocation({ tokenIds: [key], grantId: entry.grant.id });
}

/** True when a nonce is currently outstanding — i.e. local pairing is armed. */
export function hasLivePairingNonce(now: number = Date.now()): boolean {
  prune(nonces, now);
  return nonces.size > 0;
}

/** Test seam. */
export function resetPairingState(): void {
  nonces.clear();
  sessions.clear();
  redeemListeners.clear();
  useListeners.clear();
  revokeListeners.clear();
}
