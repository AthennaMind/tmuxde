import { describe, it, expect, afterEach } from "vitest";
import {
  generateMasterKey,
  seal,
  open,
  sealJson,
  openJson,
  recordAad,
  wrapAad,
  derivePinKey,
  pbkdf2Iterations,
  wrapMasterKey,
  unwrapMasterKey,
  wipe,
  LOCK_AAD_PREFIX,
  FACTOR_SALT_BYTES,
  type SealedRecord,
} from "./envelope";
import { bytesToHex, hexToBytes, utf8ToBytes } from "./bytes";

const MK = Uint8Array.from({ length: 32 }, (_, i) => i);
const OTHER_MK = new Uint8Array(32).fill(0xee);
const SALT = new Uint8Array(16).fill(0xab);
const SECRET = utf8ToBytes("directToken=deadbeef");
const AAD = recordAad("session-keys", "srv_abc");

/**
 * Golden vectors.
 *
 * These are hex constants and not recomputed values on purpose: they pin the
 * PBKDF2 iteration counts, the HKDF label and the AAD strings to the exact
 * bytes already enrolled on real devices. Changing any of those is not a
 * refactor — it locks every enrolled device out permanently, with no recovery
 * path — so it has to arrive as a failing test rather than a silent break.
 */
const VECTORS = {
  /** derivePinKey("123456", 16×0xab, 1000) */
  pin6at1000: "fcd2e336ae72295ae541dd3b30123196336454d40c165e8703d4f00d675a8744",
  /** …with one more iteration: a different key entirely. */
  pin6at1001: "ee17d32accb12e93e9dbfefebf6630b4f068c9861e6eb7181ca8fd537a79d918",
  /** derivePinKey("1234", 16×0xab, 1000) — RFC-style vector for a 4-digit PIN. */
  pin4at1000: "ad1782723d645e5356896630f9faef1fe922680a6c4f91f890791a6663dc129a",
  /** wrapMasterKey(pin6at1000, MK, "pin", "factor-1") */
  wrapNonce: "4c46b6e37e9f5fab46b2c85a",
  wrapCt:
    "24c36d37652452648a9e45d0fb2eb71f81931539894e03f4c9da1151c5dc52b5" +
    "5dcd4c4fcbd5b27cc7f32032ebb691ed",
} as const;

/**
 * Run one call with `globalThis.crypto.subtle` gone.
 *
 * This is what an insecure origin looks like: `http://192.168.1.4:14100` has
 * `crypto.getRandomValues` but no `crypto.subtle`, and that is exactly the URL
 * `mtmux start` prints. Keeping `getRandomValues` wired to the real thing means
 * only the branch under test changes.
 */
const realCrypto = Object.getOwnPropertyDescriptor(globalThis, "crypto");

async function withoutSubtle<T>(fn: () => T | Promise<T>): Promise<T> {
  const source = globalThis.crypto;
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: {
      getRandomValues: (a: Uint8Array<ArrayBuffer>) => source.getRandomValues(a),
    },
  });
  try {
    // Awaited inside the try, not after it: restoring `crypto` while the
    // derivation is still in flight would leave the test asserting on whichever
    // branch happened to win the race.
    return await fn();
  } finally {
    restoreCrypto();
  }
}

function restoreCrypto(): void {
  if (realCrypto) Object.defineProperty(globalThis, "crypto", realCrypto);
}

afterEach(restoreCrypto);

describe("seal / open", () => {
  it("round-trips a payload", () => {
    const record = seal(MK, SECRET, AAD);
    expect(record.v).toBe(1);
    expect(record.nonce).toHaveLength(12);
    expect(bytesToHex(open(MK, record, AAD))).toBe(bytesToHex(SECRET));
  });

  it("round-trips an empty payload", () => {
    const record = seal(MK, new Uint8Array(), AAD);
    expect(open(MK, record, AAD)).toHaveLength(0);
  });

  it("round-trips JSON, including nested objects", () => {
    const value = { sessionLocks: { work: true }, tokens: ["a", "b"], n: 7 };
    const record = sealJson(MK, value, AAD);
    expect(openJson<typeof value>(MK, record, AAD)).toEqual(value);
  });

  it("never emits the plaintext into the record", () => {
    const record = seal(MK, SECRET, AAD);
    expect(bytesToHex(record.ct)).not.toContain(bytesToHex(SECRET));
  });

  it("appends a 16-byte GCM tag", () => {
    expect(seal(MK, SECRET, AAD).ct).toHaveLength(SECRET.length + 16);
  });

  it("refuses a key that is not 32 bytes", () => {
    expect(() => seal(new Uint8Array(16), SECRET, AAD)).toThrow(/32 bytes/);
    expect(() => open(new Uint8Array(16), seal(MK, SECRET, AAD), AAD)).toThrow(/32 bytes/);
  });

  it("refuses an empty AAD — an unbound record is a relocatable record", () => {
    expect(() => seal(MK, SECRET, "")).toThrow(/non-empty AAD/);
    expect(() => open(MK, seal(MK, SECRET, AAD), "")).toThrow(/non-empty AAD/);
  });

  it("refuses a record from an unknown version", () => {
    const record = {
      ...seal(MK, SECRET, AAD),
      v: 2,
    } as unknown as SealedRecord;
    expect(() => open(MK, record, AAD)).toThrow(/Unknown sealed record version/);
  });
});

describe("seal / open reject tampering", () => {
  it("fails under the wrong master key", () => {
    const record = seal(MK, SECRET, AAD);
    expect(() => open(OTHER_MK, record, AAD)).toThrow(/failed authentication/);
  });

  it("fails on a truncated ciphertext", () => {
    const record = seal(MK, SECRET, AAD);
    const chopped = {
      ...record,
      ct: record.ct.subarray(0, record.ct.length - 4),
    };
    expect(() => open(MK, chopped, AAD)).toThrow(/failed authentication/);

    // Shorter than the tag itself: caught before it ever reaches GCM.
    expect(() => open(MK, { ...record, ct: record.ct.subarray(0, 8) }, AAD)).toThrow(/truncated/);
  });

  it("fails on a flipped tag byte", () => {
    const record = seal(MK, SECRET, AAD);
    const ct = Uint8Array.from(record.ct);
    ct[ct.length - 1] = (ct[ct.length - 1] ?? 0) ^ 0x80;
    expect(() => open(MK, { ...record, ct }, AAD)).toThrow(/failed authentication/);
  });

  it("fails on a flipped ciphertext byte", () => {
    const record = seal(MK, SECRET, AAD);
    const ct = Uint8Array.from(record.ct);
    ct[0] = (ct[0] ?? 0) ^ 0x01;
    expect(() => open(MK, { ...record, ct }, AAD)).toThrow(/failed authentication/);
  });

  it("fails on a rewritten nonce", () => {
    const record = seal(MK, SECRET, AAD);
    const nonce = Uint8Array.from(record.nonce);
    nonce[0] = (nonce[0] ?? 0) ^ 0x01;
    expect(() => open(MK, { ...record, nonce }, AAD)).toThrow(/failed authentication/);
  });

  it("fails on a malformed nonce length", () => {
    const record = seal(MK, SECRET, AAD);
    expect(() => open(MK, { ...record, nonce: new Uint8Array(8) }, AAD)).toThrow(/malformed nonce/);
  });

  /**
   * The relocation test.
   *
   * An attacker with IndexedDB *write* access can move bytes between slots
   * freely. Without AAD they could drop machine A's sealed keys into machine
   * B's slot and have the app decrypt and use them. This is the property that
   * stops that, so it is the single most important case in the file.
   */
  it("refuses a record relocated into another machine's slot", () => {
    const sealedForA = seal(MK, SECRET, recordAad("session-keys", "srv_A"));
    expect(() => open(MK, sealedForA, recordAad("session-keys", "srv_B"))).toThrow(
      /failed authentication/,
    );
  });

  it("refuses a record relocated into another slot on the same machine", () => {
    const sealedForKeys = seal(MK, SECRET, recordAad("session-keys", "srv_A"));
    expect(() => open(MK, sealedForKeys, recordAad("device-key", "srv_A"))).toThrow(
      /failed authentication/,
    );
  });
});

describe("nonces", () => {
  /**
   * Nonce reuse under one GCM key leaks the authentication key and lets an
   * attacker forge *any* record. `seal()` takes no nonce parameter precisely so
   * a caller cannot cause this; this test is what proves the generator is
   * actually being called per seal rather than hoisted somewhere.
   */
  it("gives 1,000 seals of identical plaintext 1,000 distinct nonces", () => {
    const nonces = new Set<string>();
    const ciphertexts = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      const record = seal(MK, SECRET, AAD);
      nonces.add(bytesToHex(record.nonce));
      ciphertexts.add(bytesToHex(record.ct));
    }
    expect(nonces.size).toBe(1000);
    expect(ciphertexts.size).toBe(1000);
  });
});

describe("AAD construction", () => {
  it("builds the documented strings", () => {
    expect(LOCK_AAD_PREFIX).toBe("tmuxde/lock/v1");
    expect(recordAad("session-keys", "srv_abc")).toBe("tmuxde/lock/v1|rec|session-keys|srv_abc");
    expect(wrapAad("pin", "factor-1")).toBe("tmuxde/lock/v1|wrap|pin|factor-1");
  });

  it("keeps record and wrap AADs in separate namespaces", () => {
    expect(recordAad("pin", "x")).not.toBe(wrapAad("pin", "x"));
  });

  /**
   * An ambiguous encoding would mean two different (slot, id) pairs sharing an
   * AAD — which is the relocation the AAD exists to prevent, reintroduced by a
   * separator collision.
   */
  it("refuses a separator inside a field", () => {
    expect(() => recordAad("a|b", "c")).toThrow(/\|/);
    expect(() => recordAad("a", "b|c")).toThrow(/\|/);
    expect(() => wrapAad("pin|x", "id")).toThrow(/\|/);
    expect(() => recordAad("", "id")).toThrow(/non-empty/);
  });
});

describe("generateMasterKey", () => {
  it("produces 32 distinct random bytes each call", () => {
    const keys = new Set<string>();
    for (let i = 0; i < 100; i++) {
      const mk = generateMasterKey();
      expect(mk).toHaveLength(32);
      keys.add(bytesToHex(mk));
    }
    expect(keys.size).toBe(100);
  });
});

describe("derivePinKey", () => {
  it("matches the pinned vectors", async () => {
    expect(bytesToHex(await derivePinKey("123456", SALT, 1000))).toBe(VECTORS.pin6at1000);
    expect(bytesToHex(await derivePinKey("1234", SALT, 1000))).toBe(VECTORS.pin4at1000);
  });

  it("changes completely with one more iteration", async () => {
    expect(bytesToHex(await derivePinKey("123456", SALT, 1001))).toBe(VECTORS.pin6at1001);
    expect(VECTORS.pin6at1001).not.toBe(VECTORS.pin6at1000);
  });

  it("changes with the salt", async () => {
    const other = new Uint8Array(16).fill(0xcd);
    expect(bytesToHex(await derivePinKey("123456", other, 1000))).not.toBe(VECTORS.pin6at1000);
  });

  it("rejects an empty PIN, a bad iteration count and a missing salt", async () => {
    await expect(derivePinKey("", SALT, 1000)).rejects.toThrow(/cannot be empty/);
    await expect(derivePinKey("1234", SALT, 0)).rejects.toThrow(/positive/);
    await expect(derivePinKey("1234", SALT, 1.5)).rejects.toThrow(/positive/);
    await expect(derivePinKey("1234", new Uint8Array(), 1000)).rejects.toThrow(/salt/);
  });

  /**
   * The worst possible bug in this file is a fallback that quietly derives a
   * *different* key from the same inputs: enrollment on a secure origin would
   * then be un-unlockable from the LAN URL, and the only symptom would be "wrong
   * PIN" on a correct PIN.
   */
  it("agrees bit-for-bit between WebCrypto and the pure-JS fallback", async () => {
    for (const [pin, iterations] of [
      ["1234", 1000],
      ["123456", 1000],
      ["12345678", 2048],
      ["0000", 1],
    ] as const) {
      const web = await derivePinKey(pin, SALT, iterations);
      const noble = await withoutSubtle(() => derivePinKey(pin, SALT, iterations));
      expect(bytesToHex(noble)).toBe(bytesToHex(web));
    }
  });

  it("still derives the pinned vector with no crypto.subtle at all", async () => {
    const key = await withoutSubtle(() => derivePinKey("123456", SALT, 1000));
    expect(bytesToHex(key)).toBe(VECTORS.pin6at1000);
  });
});

describe("pbkdf2Iterations", () => {
  it("is 600,000 where WebCrypto exists", () => {
    expect(pbkdf2Iterations()).toBe(600_000);
  });

  it("drops to 100,000 on an insecure origin with no crypto.subtle", async () => {
    expect(await withoutSubtle(() => pbkdf2Iterations())).toBe(100_000);
  });

  it("exposes a 16-byte factor salt size", () => {
    expect(FACTOR_SALT_BYTES).toBe(16);
  });
});

describe("wrapMasterKey / unwrapMasterKey", () => {
  it("round-trips the master key", async () => {
    const fk = await derivePinKey("123456", SALT, 1000);
    const wrapped = await wrapMasterKey(fk, MK, "pin", "factor-1");
    const mk = await unwrapMasterKey(fk, wrapped, "pin", "factor-1");
    expect(bytesToHex(mk)).toBe(bytesToHex(MK));
  });

  /**
   * A wrong PIN is detected by the GCM tag and nothing else — there is no
   * separate verifier blob to leak an offline oracle beyond the wrap itself.
   */
  it("fails on a wrong PIN, with no separate verifier involved", async () => {
    const right = await derivePinKey("123456", SALT, 1000);
    const wrong = await derivePinKey("123457", SALT, 1000);
    const wrapped = await wrapMasterKey(right, MK, "pin", "factor-1");
    await expect(unwrapMasterKey(wrong, wrapped, "pin", "factor-1")).rejects.toThrow(
      /failed authentication/,
    );
  });

  it("fails when the iteration count differs from enrollment", async () => {
    const enrolled = await derivePinKey("123456", SALT, 1000);
    const wrapped = await wrapMasterKey(enrolled, MK, "pin", "factor-1");
    const guessed = await derivePinKey("123456", SALT, 1001);
    await expect(unwrapMasterKey(guessed, wrapped, "pin", "factor-1")).rejects.toThrow(
      /failed authentication/,
    );
  });

  it("refuses a blob wrapped for a different factor", async () => {
    const fk = await derivePinKey("123456", SALT, 1000);
    const wrapped = await wrapMasterKey(fk, MK, "pin", "factor-1");
    await expect(unwrapMasterKey(fk, wrapped, "pin", "factor-2")).rejects.toThrow(
      /failed authentication/,
    );
    await expect(unwrapMasterKey(fk, wrapped, "passkey", "factor-1")).rejects.toThrow(
      /failed authentication/,
    );
  });

  it("wraps two factors over one master key, either of which unlocks it", async () => {
    const pin = await derivePinKey("123456", SALT, 1000);
    const prf = new Uint8Array(32).fill(0x5a); // stand-in for a WebAuthn PRF
    const byPin = await wrapMasterKey(pin, MK, "pin", "f1");
    const byPasskey = await wrapMasterKey(prf, MK, "passkey", "cred_1");
    expect(bytesToHex(await unwrapMasterKey(pin, byPin, "pin", "f1"))).toBe(bytesToHex(MK));
    expect(bytesToHex(await unwrapMasterKey(prf, byPasskey, "passkey", "cred_1"))).toBe(
      bytesToHex(MK),
    );
  });

  /**
   * The wrap path as a whole, pinned to bytes: this catches a change to the
   * HKDF label or to `wrapAad()` that a round-trip test would happily pass.
   */
  it("unwraps the pinned golden blob", async () => {
    const fk = hexToBytes(VECTORS.pin6at1000);
    const wrapped: SealedRecord = {
      v: 1,
      nonce: hexToBytes(VECTORS.wrapNonce),
      ct: hexToBytes(VECTORS.wrapCt),
    };
    expect(bytesToHex(await unwrapMasterKey(fk, wrapped, "pin", "factor-1"))).toBe(bytesToHex(MK));
  });

  it("refuses to wrap anything that is not a 32-byte key", async () => {
    const fk = await derivePinKey("123456", SALT, 1000);
    await expect(wrapMasterKey(fk, new Uint8Array(16), "pin", "f1")).rejects.toThrow(/32 bytes/);
  });
});

describe("wipe", () => {
  it("zero-fills every array it is given", () => {
    const a = new Uint8Array(32).fill(1);
    const b = new Uint8Array(12).fill(2);
    wipe(a, b);
    expect(a.every((x) => x === 0)).toBe(true);
    expect(b.every((x) => x === 0)).toBe(true);
  });

  it("tolerates null and undefined, so teardown needs no guards", () => {
    const a = new Uint8Array(4).fill(9);
    expect(() => wipe(a, null, undefined)).not.toThrow();
    expect(a.every((x) => x === 0)).toBe(true);
    expect(() => wipe()).not.toThrow();
  });
});
