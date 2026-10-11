import { x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { concatBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { constantTimeEqual, lvCat, randomBytes } from "./bytes";

/**
 * Short-authentication-string pairing, for "let me onto that machine" from a
 * dashboard rather than from a code someone is standing in front of.
 *
 * The same construction as Bluetooth numeric comparison, ZRTP and Matrix SAS
 * verification: two ephemeral X25519 keys, a commitment that fixes one of them
 * before the other is revealed, and six digits derived from the agreed secret
 * that a human compares across two screens.
 *
 * ## Why this is stronger than a typed code, not weaker
 *
 * There is no secret to guess. An attacker needs the victim's authenticated
 * account session *and* a human pressing `y` at the victim's own keyboard. What
 * the SAS defends against is the one party in the middle of the exchange: the
 * broker. It forwards both ephemeral keys and could substitute its own.
 *
 * The commitment is what makes that detectable rather than merely hard.
 *
 *   1. The browser sends only `commitment = H(EB ‖ requestId)`.
 *   2. The CLI replies with its own `EC`, having seen no key yet.
 *   3. Only then does the browser reveal `EB`, and the CLI checks the
 *      commitment.
 *
 * Substituting `EC` changes the SAS the browser computes, so the two screens
 * disagree. Substituting `EB` fails the commitment check outright. Committing
 * *before* seeing `EC` is the load-bearing part: without it, a broker could
 * grind candidate keys until it found one whose SAS matched what the browser
 * would show. With it, the attack is a single online 1-in-10^6 guess that a
 * human sees fail.
 *
 * The broker never sees either private key, and never sees the descriptor
 * plaintext. It learns that a request happened, which it must not write down.
 */

/** Digits a human compares. 10^6, single-shot, checked by eye. */
export const SAS_DIGITS = 6;

const COMMIT_DOMAIN = utf8ToBytes("tmuxde/v1 rtp-commit");
const SAS_LABEL = "tmuxde/v1 sas";
const SAS_BYTES = 8;

export type EphemeralKeyPair = {
  /** X25519 private scalar. Never leaves the process that made it. */
  secret: Uint8Array;
  /** X25519 public key, the thing that crosses the broker. */
  publicKey: Uint8Array;
};

/** A fresh ephemeral key for exactly one request. */
export function newEphemeralKey(): EphemeralKeyPair {
  const secret = randomBytes(32);
  return { secret, publicKey: x25519.getPublicKey(secret) };
}

/**
 * Bind a public key to one request id.
 *
 * The request id is inside the hash so a commitment cannot be lifted from one
 * request and replayed into another.
 */
export function sasCommitment(
  publicKey: Uint8Array,
  requestId: string,
): Uint8Array {
  return sha256(
    concatBytes(COMMIT_DOMAIN, lvCat(publicKey, utf8ToBytes(requestId))),
  );
}

/**
 * Check a revealed key against the commitment that preceded it.
 *
 * Constant-time, and the only thing standing between a substituted `EB` and a
 * silently successful man-in-the-middle.
 */
export function verifySasCommitment(
  commitment: Uint8Array,
  publicKey: Uint8Array,
  requestId: string,
): boolean {
  return constantTimeEqual(commitment, sasCommitment(publicKey, requestId));
}

/**
 * Everything both sides must agree on, in one buffer.
 *
 * Length-prefixed so no two different transcripts can serialise the same way,
 * and ordered identically on both ends — a transcript that differed by field
 * order would derive two different keys from one correct exchange, which looks
 * exactly like an attack.
 */
export function sasTranscript(
  requestId: string,
  commitment: Uint8Array,
  browserPublicKey: Uint8Array,
  cliPublicKey: Uint8Array,
): Uint8Array {
  return lvCat(
    utf8ToBytes(requestId),
    commitment,
    browserPublicKey,
    cliPublicKey,
  );
}

/**
 * The X25519 shared secret, rejecting a peer key that produces the all-zero
 * output.
 *
 * That is the low-order-point case: a peer offering one forces a known shared
 * secret regardless of our scalar, which would let the broker fix the SAS.
 * `@noble/curves` already throws on it; this makes the intent explicit and
 * survives that behaviour changing.
 */
export function sasSharedSecret(
  ownSecret: Uint8Array,
  peerPublicKey: Uint8Array,
): Uint8Array {
  const shared = x25519.getSharedSecret(ownSecret, peerPublicKey);
  if (shared.every((byte) => byte === 0)) {
    throw new Error("Degenerate X25519 shared secret");
  }
  return shared;
}

/**
 * The six digits both screens show.
 *
 * Derived from the same ikm and transcript as the session keys but under its
 * own HKDF label, so showing the SAS to a human — which is the entire point —
 * reveals nothing about the keys that carry the session.
 *
 * Reduced modulo 10^6 from 64 bits. The resulting bias is on the order of
 * 10^-13 and irrelevant: this is compared once, by eye, against an online
 * attacker who gets one attempt.
 */
export function deriveSas(ikm: Uint8Array, transcript: Uint8Array): string {
  const bytes = hkdf(
    sha256,
    ikm,
    transcript,
    utf8ToBytes(SAS_LABEL),
    SAS_BYTES,
  );
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return String(value % 10n ** BigInt(SAS_DIGITS)).padStart(SAS_DIGITS, "0");
}

/** `482173` → `482 173`, so two people can read it to each other. */
export function formatSas(sas: string): string {
  return `${sas.slice(0, 3)} ${sas.slice(3)}`;
}
