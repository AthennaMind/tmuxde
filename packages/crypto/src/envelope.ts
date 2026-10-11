import { gcm } from "@noble/ciphers/aes.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { pbkdf2Async } from "@noble/hashes/pbkdf2.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { randomBytes, utf8ToBytes, wipe } from "./bytes";

/**
 * The device-lock envelope — encryption at rest for the browser's key material.
 *
 * A lock that is only a UI overlay is worthless: the pairing keys sit in
 * IndexedDB and devtools reads them in one line. So the lock is real
 * encryption, arranged as one master key and a wrap per unlock factor:
 *
 *     MK (32 random bytes, never persisted in the clear)
 *      ├─ wrapped once per factor:  WK   = HKDF-SHA-256(FK, info="… wrap|kind|id")
 *      │                            blob = AES-256-GCM(WK, fresh nonce, aad, MK)
 *      └─ seals every secret record directly, under MK
 *
 * There is deliberately no intermediate DEK layer. The only reason one usually
 * exists is rewrapping on a factor change, and that is already satisfied here —
 * adding or removing a factor touches the wrapped-MK blobs and nothing else.
 *
 * Three decisions in here are load-bearing:
 *
 * 1. **AES-GCM comes from `@noble/ciphers`, unconditionally.** `crypto.subtle`
 *    does not exist on `http://192.168.x.x` — it is secure-context only, and
 *    `mtmux start` prints exactly such a LAN URL. A branch in the code that
 *    must never be wrong is a branch that can be wrong, so there is not one.
 *    Records are ~150 bytes; the pure-JS penalty is microseconds.
 *
 * 2. **`seal()` takes no nonce.** It generates a fresh 12-byte random nonce on
 *    every single call. Reusing a nonce under one GCM key leaks the
 *    authentication key outright and lets an attacker forge *any* record, not
 *    just replay one — so the API makes the mistake unexpressible rather than
 *    merely discouraged.
 *
 * 3. **AAD is mandatory and binds each ciphertext to its slot.** An attacker
 *    with IndexedDB *write* access can move bytes around freely; without AAD
 *    they could relocate machine A's sealed keys into machine B's slot and have
 *    the app decrypt them happily. With it, the tag fails.
 *
 * Verification is the GCM tag and nothing else. A wrong PIN derives a wrong WK,
 * which fails the tag. There is no separate verifier blob to leak an oracle.
 *
 * PBKDF2 is the one place this file prefers WebCrypto (see `derivePinKey`),
 * because there the 10–30× pure-JS penalty *is* the brute-force resistance.
 *
 * **What cannot be wiped.** `wipe()` zero-fills the `Uint8Array`s it is given,
 * which is the best JS offers. It does nothing for strings: `SessionKeys`'
 * `directToken` is a JS string, and once one exists it stays in the heap until
 * the GC feels like it — unreachable, but not erased, and not something the
 * program can force. Anything that must be wipeable has to be bytes.
 */

/** Domain prefix for every AAD and HKDF label in the lock. */
export const LOCK_AAD_PREFIX = "tmuxde/lock/v1";

const MASTER_KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

/** Salt size for a factor. 16 bytes is the PBKDF2 recommendation and plenty. */
export const FACTOR_SALT_BYTES = 16;

const ITERATIONS_WEBCRYPTO = 600_000;
const ITERATIONS_FALLBACK = 100_000;

/**
 * A sealed record. Stored in IndexedDB exactly as-is.
 *
 * `nonce` and `ct` are `Uint8Array`, not base64: IDB stores typed arrays
 * structurally, so there is no encode/decode step to get wrong and no 33%
 * size tax. `ct` is the ciphertext with GCM's 16-byte tag appended, which is
 * what `@noble/ciphers` produces and consumes.
 */
export type SealedRecord = {
  v: 1;
  nonce: Uint8Array;
  ct: Uint8Array;
};

export type FactorKind = "pin" | "passkey";

/**
 * One way to unwrap the master key.
 *
 * `iterations` is written here at enrollment and read back at unlock. It is
 * never hardcoded at verify time — the moment a future release raises the
 * default, every already-enrolled device would derive a different key and be
 * permanently bricked with no path back.
 */
export type FactorRecord = {
  v: 1;
  kind: FactorKind;
  /** Stable per-factor id: the credential id for a passkey, else a random tag. */
  id: string;
  salt: Uint8Array;
  /** PBKDF2 iterations used at ENROLLMENT. Meaningless for `passkey`. */
  iterations: number;
  /** AES-256-GCM(WK, nonce, aad) over the 32-byte master key. */
  wrapped: SealedRecord;
  createdAt: number;
  label?: string;
};

/**
 * A fresh master key.
 *
 * `randomBytes` is `crypto.getRandomValues`, which — unlike `crypto.subtle` —
 * is available on an insecure origin, so this works on the LAN URL too.
 */
export function generateMasterKey(): Uint8Array {
  return randomBytes(MASTER_KEY_BYTES);
}

function assertKey(key: Uint8Array, what: string): void {
  if (key.length !== MASTER_KEY_BYTES) {
    throw new Error(`${what} must be ${MASTER_KEY_BYTES} bytes (AES-256)`);
  }
}

function aadBytes(aad: string): Uint8Array {
  // Not merely "provide something": an empty AAD is the same as no AAD, and a
  // record sealed with one is relocatable. Requiring it here is what makes the
  // binding a property of the type rather than of every call site.
  if (typeof aad !== "string" || aad.length === 0) {
    throw new Error("Sealing requires a non-empty AAD");
  }
  return utf8ToBytes(aad);
}

/**
 * Seal a payload under the master key.
 *
 * There is no nonce parameter, on purpose — see the note at the top of the
 * file. Every call gets its own random nonce, so no caller can reuse one.
 */
export function seal(
  mk: Uint8Array,
  plaintext: Uint8Array,
  aad: string,
): SealedRecord {
  assertKey(mk, "The master key");
  const nonce = randomBytes(NONCE_BYTES);
  return { v: 1, nonce, ct: gcm(mk, nonce, aadBytes(aad)).encrypt(plaintext) };
}

/** Open a sealed record. Throws if the tag, the key or the AAD is wrong. */
export function open(
  mk: Uint8Array,
  record: SealedRecord,
  aad: string,
): Uint8Array {
  assertKey(mk, "The master key");
  const info = aadBytes(aad);

  // The record came off disk, so its type is a claim rather than a fact.
  const version = (record as { v?: unknown } | null | undefined)?.v;
  if (version !== 1) {
    throw new Error(`Unknown sealed record version: ${String(version)}`);
  }
  if (record.nonce.length !== NONCE_BYTES) {
    throw new Error("Sealed record has a malformed nonce");
  }
  if (record.ct.length < TAG_BYTES) {
    throw new Error("Sealed record is truncated");
  }

  try {
    return gcm(mk, record.nonce, info).decrypt(record.ct);
  } catch {
    // Deliberately opaque, and deliberately identical for a wrong key, a
    // wrong AAD and a flipped byte: this same failure is how a wrong PIN is
    // detected, and distinguishing the cases would hand an attacker a hint
    // about which part of a forged record was rejected.
    throw new Error("Sealed record failed authentication");
  }
}

export function sealJson<T>(
  mk: Uint8Array,
  value: T,
  aad: string,
): SealedRecord {
  const json = JSON.stringify(value);
  if (json === undefined) {
    throw new Error("sealJson: value is not representable as JSON");
  }
  return seal(mk, utf8ToBytes(json), aad);
}

export function openJson<T>(
  mk: Uint8Array,
  record: SealedRecord,
  aad: string,
): T {
  return JSON.parse(new TextDecoder().decode(open(mk, record, aad))) as T;
}

/**
 * `|` is the field separator, so it cannot appear inside a field.
 *
 * Same reasoning as `lvCat` in ./bytes: an ambiguous encoding means two
 * different tuples can produce one string, and here that would mean two
 * different slots sharing an AAD — exactly the relocation the AAD exists to
 * prevent. Cheap to make impossible, so make it impossible.
 */
function field(value: string, what: string): string {
  if (value.length === 0 || value.includes("|")) {
    throw new Error(`Lock ${what} must be non-empty and contain no "|"`);
  }
  return value;
}

/** AAD for a sealed record: binds the ciphertext to one slot on one machine. */
export function recordAad(slot: string, id: string): string {
  return `${LOCK_AAD_PREFIX}|rec|${field(slot, "slot")}|${field(id, "id")}`;
}

/** AAD for a wrapped master key: binds the blob to one factor. */
export function wrapAad(kind: string, id: string): string {
  return `${LOCK_AAD_PREFIX}|wrap|${field(kind, "factor kind")}|${field(id, "factor id")}`;
}

/**
 * WebCrypto's PBKDF2 slice, typed structurally rather than via `lib.dom`.
 *
 * Same reason as ./frames: this package is compiled by the browser, the CLI
 * and the broker, and the node-targeted tsconfigs deliberately omit the DOM
 * lib. Declaring the two methods we use keeps @repo/crypto compilable from all
 * of them.
 */
declare const PBKDF2_KEY: unique symbol;
type OpaqueKey = { readonly [PBKDF2_KEY]: true };

type Pbkdf2Params = {
  name: "PBKDF2";
  hash: "SHA-256";
  salt: Uint8Array;
  iterations: number;
};

type SubtleLike = {
  importKey(
    format: "raw",
    keyData: Uint8Array,
    algorithm: "PBKDF2",
    extractable: boolean,
    usages: string[],
  ): Promise<OpaqueKey>;
  deriveBits(
    algorithm: Pbkdf2Params,
    key: OpaqueKey,
    length: number,
  ): Promise<ArrayBuffer>;
};

function subtleOrNull(): SubtleLike | null {
  const c = (globalThis as { crypto?: { subtle?: unknown } }).crypto;
  return c?.subtle ? (c.subtle as SubtleLike) : null;
}

/**
 * The PBKDF2 work factor to record at enrollment.
 *
 * 600,000 is OWASP's current PBKDF2-HMAC-SHA-256 figure and is what WebCrypto
 * can do without freezing the tab. The pure-JS fallback runs 10–30× slower for
 * the same count, so a LAN-origin enrollment takes 100,000 instead — a real
 * reduction in brute-force cost, accepted because the alternative is an
 * enrollment that hangs the browser for half a minute and gets abandoned.
 *
 * Call this once, at enrollment, and store the result in the FactorRecord.
 * Never call it at verify time.
 */
export function pbkdf2Iterations(): number {
  return subtleOrNull() ? ITERATIONS_WEBCRYPTO : ITERATIONS_FALLBACK;
}

/**
 * Stretch a PIN into a 32-byte factor key.
 *
 * This is the one function in the lock that prefers WebCrypto, because here
 * the pure-JS penalty is not a rounding error — it *is* the brute-force
 * resistance, and a slow implementation buys the attacker the same speedup it
 * costs the user. Both paths are PBKDF2-HMAC-SHA-256 over the UTF-8 PIN and
 * must produce bit-identical output for the same (pin, salt, iterations);
 * envelope.test.ts pins that, because a fallback that silently derived a
 * different key would lock people out of their own devices with no diagnosis.
 *
 * `iterations` is a parameter rather than a constant so that unlock can use the
 * count read back from the FactorRecord.
 */
export async function derivePinKey(
  pin: string,
  salt: Uint8Array,
  iterations: number,
): Promise<Uint8Array> {
  if (pin.length === 0) {
    throw new Error("A lock PIN cannot be empty");
  }
  if (!Number.isInteger(iterations) || iterations < 1) {
    throw new Error("PBKDF2 iterations must be a positive integer");
  }
  if (salt.length === 0) {
    throw new Error("A lock factor needs a salt");
  }

  const password = utf8ToBytes(pin);
  const subtle = subtleOrNull();
  if (subtle) {
    const key = await subtle.importKey("raw", password, "PBKDF2", false, [
      "deriveBits",
    ]);
    const bits = await subtle.deriveBits(
      { name: "PBKDF2", hash: "SHA-256", salt, iterations },
      key,
      MASTER_KEY_BYTES * 8,
    );
    return new Uint8Array(bits);
  }

  // `pbkdf2Async` yields to the scheduler between blocks, so the insecure-origin
  // path does not freeze the tab for the whole derivation.
  return pbkdf2Async(sha256, password, salt, {
    c: iterations,
    dkLen: MASTER_KEY_BYTES,
  });
}

/**
 * The wrapping key for one factor.
 *
 * HKDF is given no salt: for a PIN the salt has already been spent inside
 * PBKDF2, and for a passkey the PRF output is 256 bits of real entropy. What
 * HKDF adds here is the `info` label, which separates the factors — two
 * factors that happened to derive the same FK still get different WKs, and a
 * blob wrapped for one factor is not openable as another.
 */
function wrappingKey(
  factorKey: Uint8Array,
  kind: string,
  id: string,
): Uint8Array {
  const info = `${LOCK_AAD_PREFIX} wrap|${field(kind, "factor kind")}|${field(id, "factor id")}`;
  return hkdf(
    sha256,
    factorKey,
    undefined,
    utf8ToBytes(info),
    MASTER_KEY_BYTES,
  );
}

/**
 * Wrap the master key for one factor.
 *
 * Async only to keep one shape across factors — the caller has just awaited
 * `derivePinKey` or a WebAuthn PRF, and a sync function here would invite a
 * missing `await` on the unwrap side, where it matters.
 */
export async function wrapMasterKey(
  factorKey: Uint8Array,
  mk: Uint8Array,
  kind: string,
  id: string,
): Promise<SealedRecord> {
  assertKey(mk, "The master key");
  const wk = wrappingKey(factorKey, kind, id);
  try {
    return seal(wk, mk, wrapAad(kind, id));
  } finally {
    wipe(wk);
  }
}

/**
 * Recover the master key from a factor. Throws if the factor is wrong.
 *
 * A wrong PIN lands here as a tag failure, which is the whole verification
 * story — see the module header.
 */
export async function unwrapMasterKey(
  factorKey: Uint8Array,
  wrapped: SealedRecord,
  kind: string,
  id: string,
): Promise<Uint8Array> {
  const wk = wrappingKey(factorKey, kind, id);
  let mk: Uint8Array;
  try {
    mk = open(wk, wrapped, wrapAad(kind, id));
  } finally {
    wipe(wk);
  }
  if (mk.length !== MASTER_KEY_BYTES) {
    // Authenticated, so this is not tampering — it is a record this version
    // does not understand. Failing loudly beats handing a short key to AES.
    wipe(mk);
    throw new Error("Unwrapped master key is the wrong length");
  }
  return mk;
}

export { wipe } from "./bytes";
