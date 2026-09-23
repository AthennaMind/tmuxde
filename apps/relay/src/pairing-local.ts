import crypto from "node:crypto";
import type { GrantRecord } from "@repo/protocol";
import { isGrantActive } from "@repo/protocol";
import { FULL_GRANT } from "./grant.js";

/**
 * Tokenless sign-in for a device on the same network.
 *
 * `mtmux start` prints a QR encoding `http://<lan-ip>:<port>/login#n=<nonce>`
 * **and six digits to type**. Either one redeems here for a scoped, expiring
 * session token. The 64-hex `AUTH_TOKEN` is never shown to the phone and never
 * typed by hand.
 *
 * ## Why there are two halves, and why they are one offer
 *
 * The QR is for a camera and the digits are for everything a camera cannot do
 * — a laptop on the same wifi, a phone that will not grant camera permission,
 * a tablet held at the wrong angle. Until they existed, local mode's answer to
 * "I cannot scan that" was a 64-character token, which is not an answer.
 *
 * They are one `offer` rather than two because they are two spellings of the
 * same permission. Spending either spends both, which is what stops a
 * screenshot of the QR from staying live after somebody has typed the digits.
 *
 * Three properties carry the security argument:
 *
 *  - **Single use.** A photo of the terminal taken after the first scan is
 *    worthless, and a redeemed nonce or code cannot be replayed.
 *  - **A guess budget.** Six digits are guessable; six digits with five tries
 *    are not. `MAX_CODE_ATTEMPTS` wrong answers burn the offer and the
 *    terminal prints a fresh one.
 *  - **Consent, separately.** A correct code is not permission. Redemption
 *    raises the same approval question every other path raises, through
 *    `gate` below — see `access-prompt.ts` in the CLI for the argument that
 *    knowing a code and consenting to a pairing are different facts.
 *
 * And, as before:
 *
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
 * offer is ever armed — `redeemLocalPairing` then rejects unconditionally and
 * the endpoint is inert.
 */

const NONCE_TTL_MS = 15 * 60 * 1000;
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Wrong six-digit guesses a printed code survives before it is thrown away.
 *
 * This number is the local code's security argument, not its length — see the
 * header of `@repo/crypto`'s `local-code.ts`. Five is chosen to be survivable
 * by a person typing on a phone with a cracked screen and hopeless for anything
 * else: a million-code space needs the code to live through a great many more
 * guesses than that before a search means anything.
 *
 * Exhausting it does not lock anybody out. The code is burned, the terminal is
 * told, and it prints a fresh one — so the cost of being guessed at is that
 * somebody has to look at the screen again.
 */
const MAX_CODE_ATTEMPTS = 5;

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

/**
 * The one credential `mtmux start` is currently showing, in both spellings.
 *
 * Singular, and that is deliberate: a second armed offer would mean a code
 * printed ten minutes ago still worked, which is precisely what "the terminal
 * shows the live code" has to mean for the terminal to be trustworthy. Arming
 * replaces.
 */
type LocalOffer = {
  /** `digest()` of the QR nonce. */
  nonceKey: string;
  /** `digest()` of the six typed digits. */
  codeKey: string;
  expiresAt: number;
  /** Wrong guesses so far, against `MAX_CODE_ATTEMPTS`. */
  wrong: number;
};

let offer: LocalOffer | null = null;
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
 * Constant-time comparison of two hex digests.
 *
 * The values compared are SHA-256 of a six-digit code, so a timing oracle here
 * leaks at most which prefix of a *digest* matched — not of the code, which is
 * the thing worth protecting. It is done properly anyway because the cost is
 * one function call and the alternative is a reader having to work that out.
 */
function sameDigest(a: string, b: string): boolean {
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  if (left.length !== right.length || left.length === 0) return false;
  return crypto.timingSafeEqual(left, right);
}

/**
 * What became of the credential the terminal is showing.
 *
 * Every one of these means "what is on screen is now wrong", which is why they
 * share a listener rather than only reporting success. A code that was guessed
 * at five times is as dead as one that was used, and a terminal still showing
 * it is a terminal lying to its owner.
 */
export type LocalPairingOutcome =
  /** A device redeemed it and was let in. */
  | "paired"
  /** A device redeemed it and the human at the machine said no. */
  | "refused"
  /** Burned by wrong guesses. Nobody got in. */
  | "burned";

/**
 * Notified whenever the printed credential is spent, so the CLI can arm a
 * fresh one and reprint — otherwise the code on screen is silently dead after
 * the first device pairs, or after the fifth wrong guess.
 */
const spentListeners = new Set<(outcome: LocalPairingOutcome) => void>();

export function onLocalPairingSpent(
  listener: (outcome: LocalPairingOutcome) => void,
): () => void {
  spentListeners.add(listener);
  return () => spentListeners.delete(listener);
}

function emitSpent(outcome: LocalPairingOutcome): void {
  for (const listener of spentListeners) {
    try {
      listener(outcome);
    } catch {
      // A misbehaving listener must never fail the pairing itself.
    }
  }
}

/**
 * The question asked at the machine before a local device is let in.
 *
 * Installed by the CLI, which owns every approval channel there is — the TTY,
 * the live panel, `mtmux approve`, and a dialog on any phone already
 * connected. The relay deliberately knows none of that; it knows only that
 * something has to say yes.
 *
 * Unset means there is nobody to ask, and **that is a yes**. It has to be: in
 * split mode (`apps/relay` standalone) no offer is ever armed, so this is
 * unreachable there; and in single-port mode the CLI installs it during boot.
 * The failure mode of the other choice — refusing when no gate is installed —
 * would be a phone that cannot sign in against an older CLI bundle, reported
 * as "pairing is broken" with nothing on screen to explain it.
 */
export type LocalPairingRequest = {
  /** What the browser says it is, e.g. "iPhone · Safari". Never trusted. */
  label: string;
  /** How it redeemed: the QR, or the typed digits. */
  via: "scan" | "code";
  /**
   * The device id this pairing will be recorded under, minted before the
   * question is asked.
   *
   * It exists so the answer can be *carried*. Approving a pairing and then
   * asking again the moment the same browser opens its socket is the same
   * question twice, thirty milliseconds apart, and a product that does that
   * teaches people to hit yes without reading. The CLI seeds its connection
   * gate with this id, so the pairing approval covers the connection it was
   * given for — and nothing else.
   */
  deviceId: string;
};

let gate: ((req: LocalPairingRequest) => Promise<boolean>) | null = null;

export function setLocalPairingGate(
  next: ((req: LocalPairingRequest) => Promise<boolean>) | null,
): void {
  gate = next;
}

export type PairingNonce = { nonce: string; expiresAt: number };

/**
 * Strip a typed code to its digits, or null.
 *
 * People type "483 921" and "483-921" and paste "483921", and a code that
 * rejects a space is a code that gets retyped. Deliberately *not* a length
 * check: the length of the code is the caller's business — the relay is handed
 * the digits to arm and only ever compares against them — and a second
 * hard-coded six here would be a second place to forget to change.
 */
function normalizeTyped(input: string): string | null {
  const digits = input.replace(/[\s-]/g, "");
  return /^\d+$/.test(digits) ? digits : null;
}

/**
 * Arm one local pairing offer — a QR nonce and the digits to type.
 *
 * Replaces any previous offer, so exactly one is live at a time and it is
 * always the one on screen.
 *
 * The digits are handed *in* rather than minted here, and that is the point:
 * `@repo/crypto`'s `local-code.ts` owns what a local code is, the CLI prints
 * what it generated, and the relay never holds a second opinion about the
 * format. It hashes what it was given and compares. The relay also stays free
 * of a crypto dependency it would otherwise carry into the standalone image
 * for the sake of six digits.
 */
export function armLocalPairing(
  code: string,
  ttlMs: number = NONCE_TTL_MS,
  now: number = Date.now(),
): PairingNonce {
  const digits = normalizeTyped(code);
  if (digits === null) throw new Error("Local pairing code must be digits");
  const nonce = crypto.randomBytes(16).toString("base64url");
  const expiresAt = now + ttlMs;
  offer = {
    nonceKey: digest(nonce),
    codeKey: digest(digits),
    expiresAt,
    wrong: 0,
  };
  return { nonce, expiresAt };
}

export type SessionToken = { token: string; expiresAt: number };

export type LocalPairingResult =
  | { ok: true; session: SessionToken }
  /** Wrong, expired, or already spent. Says nothing about which. */
  | { ok: false; reason: "invalid" }
  /** Right, but the human at the machine said no — or nobody answered. */
  | { ok: false; reason: "refused" };

/**
 * Redeem the QR nonce or the typed code for a session token.
 *
 * ## The order of operations, which is the whole of the security argument
 *
 * The offer is **burned before the human is asked**, not after. Asking first
 * would leave a correct code live for the hundred-odd seconds the question sits
 * on screen, which is exactly the window an attacker who guessed it wants: say
 * no to the first attempt and the same code is still good for the second. So a
 * correct answer spends the offer whatever the human then decides, and a
 * refusal costs the legitimate owner one glance at a freshly printed code.
 *
 * A wrong answer spends a guess instead, and the fifth one burns the offer —
 * see `MAX_CODE_ATTEMPTS`. Nothing distinguishes "wrong" from "expired" or
 * "already used" in the return value, because a caller that can tell them
 * apart is an oracle for whether a code was ever live.
 */
export async function redeemLocalPairing(
  credential: { nonce?: string; code?: string },
  req: { label?: string } = {},
  now: number = Date.now(),
): Promise<LocalPairingResult> {
  const current = offer;
  if (!current || current.expiresAt <= now) {
    offer = null;
    return { ok: false, reason: "invalid" };
  }

  const via = resolveVia(current, credential);
  if (via === null) {
    // A wrong *code* is a guess and is billed as one. A wrong nonce is not:
    // it is 128 bits, so it is never a guess — it is a stale QR, a second tab,
    // or a reload of a page that already paired. Billing those against the
    // typed code's budget would let a reloading browser burn the digits the
    // person at the machine is still reading out.
    if (normalizeTyped(credential.code ?? "") !== null) {
      current.wrong += 1;
      if (current.wrong >= MAX_CODE_ATTEMPTS) {
        offer = null;
        emitSpent("burned");
      }
    }
    return { ok: false, reason: "invalid" };
  }

  // Single use, and spent before the question is asked. See above.
  offer = null;

  const deviceId = `local-${crypto.randomBytes(8).toString("hex")}`;
  const allowed = gate
    ? await gate({ label: req.label ?? "", via, deviceId }).catch(() => false)
    : true;
  if (!allowed) {
    emitSpent("refused");
    return { ok: false, reason: "refused" };
  }

  const session = issueSessionToken(
    SESSION_TTL_MS,
    now,
    FULL_GRANT,
    req.label,
    deviceId,
  );
  emitSpent("paired");
  return { ok: true, session };
}

/** Which half of the offer this credential matches, if either. */
function resolveVia(
  current: LocalOffer,
  credential: { nonce?: string; code?: string },
): "scan" | "code" | null {
  if (
    credential.nonce &&
    sameDigest(digest(credential.nonce), current.nonceKey)
  )
    return "scan";
  const typed = normalizeTyped(credential.code ?? "");
  if (typed !== null && sameDigest(digest(typed), current.codeKey))
    return "code";
  return null;
}

export function issueSessionToken(
  ttlMs: number = SESSION_TTL_MS,
  now: number = Date.now(),
  grant: GrantRecord = FULL_GRANT,
  label?: string,
  deviceId?: string,
): SessionToken {
  prune(sessions, now);
  const token = crypto.randomBytes(32).toString("hex");
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

/**
 * Take the local offer down without spending it.
 *
 * For the moment a tunnel opens on a server that started local-only. The
 * banner is replaced by the hosted one, so the six digits stop being on
 * screen — and a six-digit credential that is live for another day with
 * nothing displaying it is the one shape a printed secret must never take.
 * Nothing is lost by dropping it: a hosted pairing seals the machine's LAN
 * candidates into its descriptor, so a browser on this network still gets a
 * direct socket rather than a tunnelled one.
 *
 * Silent when nothing is armed, which is the normal case — split mode never
 * arms an offer at all.
 */
export function disarmLocalPairing(): void {
  offer = null;
}

/** True when an offer is outstanding — i.e. local pairing is armed. */
export function hasLivePairingNonce(now: number = Date.now()): boolean {
  if (offer && offer.expiresAt <= now) offer = null;
  return offer !== null;
}

/** Test seam. */
export function resetPairingState(): void {
  offer = null;
  sessions.clear();
  spentListeners.clear();
  useListeners.clear();
  revokeListeners.clear();
  gate = null;
}
