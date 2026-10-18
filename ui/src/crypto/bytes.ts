export {
  bytesToHex,
  hexToBytes,
  concatBytes,
  utf8ToBytes,
  randomBytes,
} from "@noble/hashes/utils.js";

import { concatBytes } from "@noble/hashes/utils.js";

/**
 * LEB128, as CPace's `prepend_len` requires: seven bits per byte, least
 * significant first, high bit set while more bytes follow.
 */
export function leb128(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error("leb128: expected a non-negative integer");
  }
  const out: number[] = [];
  let n = value;
  do {
    let byte = n & 0x7f;
    n >>>= 7;
    if (n > 0) byte |= 0x80;
    out.push(byte);
  } while (n > 0);
  return Uint8Array.from(out);
}

/** CPace's `prepend_len(x)` — the LEB128 length followed by the value. */
export function prependLen(value: Uint8Array): Uint8Array {
  return concatBytes(leb128(value.length), value);
}

/**
 * CPace's `lv_cat` — length-prefixed concatenation. Making every field
 * length-prefixed is what makes the encoding unambiguous, so two different
 * input tuples can never produce the same transcript.
 */
export function lvCat(...values: Uint8Array[]): Uint8Array {
  return concatBytes(...values.map(prependLen));
}

/**
 * Constant-time equality. Used for MAC and key-confirmation checks, where an
 * early exit would leak how many leading bytes an attacker guessed right.
 */
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

const B64URL_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** base64url without padding. Hand-rolled so it works in Node and browsers. */
export function bytesToBase64Url(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] ?? 0;
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += B64URL_ALPHABET[b0 >> 2];
    out += B64URL_ALPHABET[((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4)];
    if (b1 === undefined) break;
    out += B64URL_ALPHABET[((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6)];
    if (b2 === undefined) break;
    out += B64URL_ALPHABET[b2 & 0x3f];
  }
  return out;
}

export function base64UrlToBytes(text: string): Uint8Array {
  const clean = text.replace(/=+$/, "");
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let bits = 0;
  let acc = 0;
  let pos = 0;
  for (const char of clean) {
    const index = B64URL_ALPHABET.indexOf(char);
    if (index < 0) throw new Error("base64UrlToBytes: invalid character");
    acc = (acc << 6) | index;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[pos++] = (acc >> bits) & 0xff;
    }
  }
  return out.subarray(0, pos);
}

/**
 * Overwrite key material in place. Best-effort — JS gives no real guarantees,
 * and it can do nothing at all for a string (see ./envelope).
 *
 * Variadic and null-tolerant because the callers are teardown paths — locking
 * the device, an aborted enrollment, a failed unwrap — where half the buffers
 * may never have been assigned. `wipe(a, b, c)` on the way out is only
 * reliably written if it never needs a guard around each argument.
 */
export function wipe(...arrays: (Uint8Array | null | undefined)[]): void {
  for (const bytes of arrays) bytes?.fill(0);
}
