import { hkdf } from "@noble/hashes/hkdf.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { utf8ToBytes } from "@noble/hashes/utils.js";
import { bytesToHex, hexToBytes, constantTimeEqual } from "./bytes";

/**
 * The key schedule hanging off a completed CPace run.
 *
 * Everything is derived from the CPace ISK with HKDF-SHA-256, salted by the
 * transcript. Separate labels per purpose mean a leak of one key never gives
 * an attacker any of the others, and the browser→CLI and CLI→browser
 * directions use different keys so a captured frame can never be reflected
 * back at its sender.
 */

const KEY_BYTES = 32;

export const LABEL = {
  c2s: "tmuxde/v1 browser→cli",
  s2c: "tmuxde/v1 cli→browser",
  confirm: "tmuxde/v1 confirm",
  directToken: "tmuxde/v1 direct-token",
} as const;

export type SessionKeys = {
  /** AES-256-GCM key for browser → CLI frames. */
  c2s: Uint8Array;
  /** AES-256-GCM key for CLI → browser frames. */
  s2c: Uint8Array;
  /** HMAC key for key confirmation. */
  confirm: Uint8Array;
  /**
   * Relay auth token for the direct path, as hex.
   *
   * Both sides compute this from the pairing key, so the browser can
   * authenticate to the relay without the long-lived AUTH_TOKEN ever crossing
   * the wire — which is the whole reason it exists.
   */
  directToken: string;
};

/**
 * Length of the per-connection salt that separates one stream's frame key
 * from another's. 128 bits, so two independently chosen salts collide with
 * negligible probability across every pairing this service will ever carry.
 */
export const SUBKEY_SALT_BYTES = 16;

/**
 * Labels for the keys actually used to seal bytes.
 *
 * `LABEL` above derives the *session* keys from the CPace ISK, and stays at
 * `tmuxde/v1` — those are what `~/.tmuxde/config.json` and IndexedDB hold, so
 * changing them would invalidate every persisted pairing. What changes at v2
 * is how those keys are consumed: never directly, always through a subkey
 * bound to a fresh salt and to what the bytes are for.
 *
 * The separate `descriptor` arm is not redundant with the salt. It is what
 * makes "seal exactly once per key schedule" a property of the key material
 * rather than an unwritten rule someone eventually breaks — the sealed
 * descriptor and the first tunnel frame were both sealed under `s2c` at
 * counter 0, which handed the broker two ciphertexts under one nonce on every
 * hosted pairing, one of them a schema-known JSON object.
 */
export const SUBKEY_LABEL = {
  frame: {
    c2s: "tmuxde/v2 frame browser→cli",
    s2c: "tmuxde/v2 frame cli→browser",
  },
  descriptor: {
    c2s: "tmuxde/v2 descriptor browser→cli",
    s2c: "tmuxde/v2 descriptor cli→browser",
  },
} as const;

export type SubkeyPurpose = keyof typeof SUBKEY_LABEL;

/**
 * One HKDF invocation, shared by both derivations in this package.
 *
 * Not exported: callers derive session keys or subkeys, never raw HKDF, so
 * there is exactly one place where a label can be got wrong.
 */
function derive(
  isk: Uint8Array,
  transcript: Uint8Array,
  label: string,
): Uint8Array {
  return hkdf(sha256, isk, transcript, utf8ToBytes(label), KEY_BYTES);
}

/**
 * The key a single connection actually seals with.
 *
 * Throws on a wrong-sized key or salt rather than deriving something. A short
 * salt is not a weaker version of this fix — it is a silent downgrade back to
 * the bug, and the one place it could enter is a peer that chose it.
 */
export function deriveSubkey(
  key: Uint8Array,
  salt: Uint8Array,
  label: string,
): Uint8Array {
  if (key.length !== KEY_BYTES) {
    throw new Error("A frame subkey needs a 32-byte session key");
  }
  if (salt.length !== SUBKEY_SALT_BYTES) {
    throw new Error(
      `A frame subkey needs a ${SUBKEY_SALT_BYTES}-byte salt, got ${salt.length}`,
    );
  }
  return derive(key, salt, label);
}

export function deriveSessionKeys(
  isk: Uint8Array,
  transcript: Uint8Array,
): SessionKeys {
  return {
    c2s: derive(isk, transcript, LABEL.c2s),
    s2c: derive(isk, transcript, LABEL.s2c),
    confirm: derive(isk, transcript, LABEL.confirm),
    directToken: bytesToHex(derive(isk, transcript, LABEL.directToken)),
  };
}

/**
 * Serialised form for `~/.tmuxde/config.json`.
 *
 * The keys are bytes and JSON has no byte type, so hex — the same encoding
 * `StoredDeviceKey` uses, for the same reason.
 */
export type StoredSessionKeys = {
  c2s: string;
  s2c: string;
  confirm: string;
  directToken: string;
};

export function encodeSessionKeys(keys: SessionKeys): StoredSessionKeys {
  return {
    c2s: bytesToHex(keys.c2s),
    s2c: bytesToHex(keys.s2c),
    confirm: bytesToHex(keys.confirm),
    directToken: keys.directToken,
  };
}

/**
 * Throws on anything malformed rather than returning a partial schedule.
 *
 * A key of the wrong length cannot decrypt anything, so the only thing a
 * lenient decode would buy is a pairing that looks restored and silently
 * refuses every frame — which is precisely the failure this whole change
 * exists to remove.
 */
export function decodeSessionKeys(stored: StoredSessionKeys): SessionKeys {
  const c2s = hexToBytes(stored.c2s);
  const s2c = hexToBytes(stored.s2c);
  const confirm = hexToBytes(stored.confirm);
  if (
    c2s.length !== KEY_BYTES ||
    s2c.length !== KEY_BYTES ||
    confirm.length !== KEY_BYTES
  ) {
    throw new Error("Stored session keys are malformed");
  }
  if (
    typeof stored.directToken !== "string" ||
    stored.directToken.length < 32
  ) {
    throw new Error("Stored session keys have no usable direct token");
  }
  return { c2s, s2c, confirm, directToken: stored.directToken };
}

export type Role = "cli" | "browser";

/**
 * Key confirmation.
 *
 * Each side proves it derived the same key before either does anything with
 * it. This is what turns a wrong four-digit guess into an immediate, visible
 * failure instead of a silently broken session — and what lets the broker
 * destroy the mailbox on a bad guess, so an attacker gets exactly one shot.
 */
export function confirmationTag(
  confirmKey: Uint8Array,
  role: Role,
): Uint8Array {
  return hmac(sha256, confirmKey, utf8ToBytes(`tmuxde/v1 confirm ${role}`));
}

export function verifyConfirmation(
  confirmKey: Uint8Array,
  role: Role,
  tag: Uint8Array,
): boolean {
  return constantTimeEqual(confirmationTag(confirmKey, role), tag);
}
