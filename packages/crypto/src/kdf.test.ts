import { describe, it, expect } from "vitest";
import {
  deriveSessionKeys,
  confirmationTag,
  verifyConfirmation,
  encodeSessionKeys,
  decodeSessionKeys,
  deriveSubkey,
  SUBKEY_LABEL,
  SUBKEY_SALT_BYTES,
} from "./kdf";
import { bytesToHex, randomBytes, utf8ToBytes } from "./bytes";

const ISK = new Uint8Array(64).fill(3);
const TRANSCRIPT = utf8ToBytes("transcript");

describe("deriveSessionKeys", () => {
  it("is deterministic for the same ISK and transcript", () => {
    const a = deriveSessionKeys(ISK, TRANSCRIPT);
    const b = deriveSessionKeys(ISK, TRANSCRIPT);
    expect(bytesToHex(a.c2s)).toBe(bytesToHex(b.c2s));
    expect(bytesToHex(a.s2c)).toBe(bytesToHex(b.s2c));
    expect(bytesToHex(a.confirm)).toBe(bytesToHex(b.confirm));
    expect(a.directToken).toBe(b.directToken);
  });

  it("produces four distinct 32-byte keys", () => {
    const k = deriveSessionKeys(ISK, TRANSCRIPT);
    expect(k.c2s).toHaveLength(32);
    expect(k.s2c).toHaveLength(32);
    expect(k.confirm).toHaveLength(32);
    expect(k.directToken).toMatch(/^[0-9a-f]{64}$/);

    const all = new Set([
      bytesToHex(k.c2s),
      bytesToHex(k.s2c),
      bytesToHex(k.confirm),
      k.directToken,
    ]);
    expect(all.size).toBe(4);
  });

  it("changes completely when the ISK changes by one bit", () => {
    const other = Uint8Array.from(ISK);
    other[0] = (other[0] ?? 0) ^ 0x01;
    const a = deriveSessionKeys(ISK, TRANSCRIPT);
    const b = deriveSessionKeys(other, TRANSCRIPT);
    expect(bytesToHex(a.c2s)).not.toBe(bytesToHex(b.c2s));
    expect(a.directToken).not.toBe(b.directToken);
  });

  it("changes when only the transcript changes", () => {
    const a = deriveSessionKeys(ISK, utf8ToBytes("transcript-a"));
    const b = deriveSessionKeys(ISK, utf8ToBytes("transcript-b"));
    expect(bytesToHex(a.c2s)).not.toBe(bytesToHex(b.c2s));
  });

  it("never leaks the ISK into any derived value", () => {
    const isk = randomBytes(64);
    const k = deriveSessionKeys(isk, TRANSCRIPT);
    const iskHex = bytesToHex(isk);
    for (const value of [
      bytesToHex(k.c2s),
      bytesToHex(k.s2c),
      bytesToHex(k.confirm),
      k.directToken,
    ]) {
      expect(iskHex).not.toContain(value);
      expect(value).not.toContain(iskHex);
    }
  });
});

describe("key confirmation", () => {
  const keys = deriveSessionKeys(ISK, TRANSCRIPT);

  it("accepts a tag from the matching role", () => {
    expect(
      verifyConfirmation(
        keys.confirm,
        "cli",
        confirmationTag(keys.confirm, "cli"),
      ),
    ).toBe(true);
    expect(
      verifyConfirmation(
        keys.confirm,
        "browser",
        confirmationTag(keys.confirm, "browser"),
      ),
    ).toBe(true);
  });

  it("rejects a tag from the other role — no reflection", () => {
    expect(
      verifyConfirmation(
        keys.confirm,
        "cli",
        confirmationTag(keys.confirm, "browser"),
      ),
    ).toBe(false);
  });

  it("rejects a tag derived from a different key", () => {
    const other = deriveSessionKeys(randomBytes(64), TRANSCRIPT);
    expect(
      verifyConfirmation(
        keys.confirm,
        "cli",
        confirmationTag(other.confirm, "cli"),
      ),
    ).toBe(false);
  });

  it("rejects a truncated or padded tag", () => {
    const tag = confirmationTag(keys.confirm, "cli");
    expect(verifyConfirmation(keys.confirm, "cli", tag.subarray(0, 31))).toBe(
      false,
    );
    expect(verifyConfirmation(keys.confirm, "cli", new Uint8Array(33))).toBe(
      false,
    );
  });

  it("rejects a single flipped bit", () => {
    const tag = confirmationTag(keys.confirm, "cli");
    tag[5] = (tag[5] ?? 0) ^ 0x01;
    expect(verifyConfirmation(keys.confirm, "cli", tag)).toBe(false);
  });
});

describe("session key serialisation", () => {
  const keys = deriveSessionKeys(ISK, TRANSCRIPT);

  it("round-trips a schedule through its stored form", () => {
    const restored = decodeSessionKeys(encodeSessionKeys(keys));
    expect(restored.c2s).toEqual(keys.c2s);
    expect(restored.s2c).toEqual(keys.s2c);
    expect(restored.confirm).toEqual(keys.confirm);
    expect(restored.directToken).toBe(keys.directToken);
  });

  it("encodes to JSON-safe strings, since this lands in config.json", () => {
    const stored = encodeSessionKeys(keys);
    expect(JSON.parse(JSON.stringify(stored))).toEqual(stored);
    for (const hex of [stored.c2s, stored.s2c, stored.confirm]) {
      expect(hex).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  /**
   * Rejecting rather than repairing is the point. A short key cannot decrypt
   * anything, so a lenient decode buys a pairing that looks restored and
   * silently refuses every frame — which is the failure this whole path exists
   * to remove.
   */
  it("refuses a key of the wrong length", () => {
    const stored = encodeSessionKeys(keys);
    expect(() => decodeSessionKeys({ ...stored, c2s: "abcd" })).toThrow(
      /malformed/i,
    );
    expect(() => decodeSessionKeys({ ...stored, s2c: "" })).toThrow(
      /malformed/i,
    );
  });

  it("refuses a schedule with no usable direct token", () => {
    const stored = encodeSessionKeys(keys);
    expect(() => decodeSessionKeys({ ...stored, directToken: "" })).toThrow(
      /direct token/i,
    );
  });

  it("refuses a non-hex key rather than decoding it to something shorter", () => {
    const stored = encodeSessionKeys(keys);
    expect(() =>
      decodeSessionKeys({ ...stored, c2s: "zz".repeat(32) }),
    ).toThrow();
  });
});

/**
 * The per-connection subkey. `LABEL` above still derives the session keys from
 * the ISK and is deliberately unchanged at `tmuxde/v1` — persisted pairings hold
 * those. What is new is that nothing seals with them directly.
 */
describe("deriveSubkey", () => {
  const KEY = new Uint8Array(32).fill(3);
  const SALT = new Uint8Array(SUBKEY_SALT_BYTES).fill(5);

  it("is deterministic for the same key, salt and label", () => {
    expect(bytesToHex(deriveSubkey(KEY, SALT, SUBKEY_LABEL.frame.c2s))).toBe(
      bytesToHex(deriveSubkey(KEY, SALT, SUBKEY_LABEL.frame.c2s)),
    );
  });

  it("differs per salt", () => {
    const other = new Uint8Array(SUBKEY_SALT_BYTES).fill(6);
    expect(
      bytesToHex(deriveSubkey(KEY, SALT, SUBKEY_LABEL.frame.c2s)),
    ).not.toBe(bytesToHex(deriveSubkey(KEY, other, SUBKEY_LABEL.frame.c2s)));
  });

  it("differs per label — direction and purpose both separate keys", () => {
    const labels = [
      SUBKEY_LABEL.frame.c2s,
      SUBKEY_LABEL.frame.s2c,
      SUBKEY_LABEL.descriptor.c2s,
      SUBKEY_LABEL.descriptor.s2c,
    ];
    const derived = labels.map((l) => bytesToHex(deriveSubkey(KEY, SALT, l)));
    expect(new Set(derived).size).toBe(labels.length);
  });

  it("differs per key", () => {
    const other = new Uint8Array(32).fill(4);
    expect(
      bytesToHex(deriveSubkey(KEY, SALT, SUBKEY_LABEL.frame.c2s)),
    ).not.toBe(bytesToHex(deriveSubkey(other, SALT, SUBKEY_LABEL.frame.c2s)));
  });

  it("returns a 32-byte key", () => {
    expect(deriveSubkey(KEY, SALT, SUBKEY_LABEL.frame.c2s)).toHaveLength(32);
  });

  /** A short salt is not a weaker fix — it is a silent return to the bug. */
  it("refuses a salt that is not 16 bytes", () => {
    expect(() =>
      deriveSubkey(KEY, new Uint8Array(15), SUBKEY_LABEL.frame.c2s),
    ).toThrow(/16-byte salt/);
    expect(() =>
      deriveSubkey(KEY, new Uint8Array(17), SUBKEY_LABEL.frame.c2s),
    ).toThrow(/16-byte salt/);
  });

  it("refuses a key that is not 32 bytes", () => {
    expect(() =>
      deriveSubkey(new Uint8Array(16), SALT, SUBKEY_LABEL.frame.c2s),
    ).toThrow(/32-byte session key/);
  });
});
