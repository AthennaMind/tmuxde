import { describe, it, expect } from "vitest";
import {
  leb128,
  prependLen,
  lvCat,
  constantTimeEqual,
  bytesToBase64Url,
  base64UrlToBytes,
  bytesToHex,
  hexToBytes,
  randomBytes,
  wipe,
} from "./bytes";

describe("leb128", () => {
  it("encodes small values in a single byte", () => {
    expect([...leb128(0)]).toEqual([0x00]);
    expect([...leb128(1)]).toEqual([0x01]);
    expect([...leb128(127)]).toEqual([0x7f]);
  });

  it("switches to two bytes at 128", () => {
    expect([...leb128(128)]).toEqual([0x80, 0x01]);
    expect([...leb128(300)]).toEqual([0xac, 0x02]);
    expect([...leb128(16383)]).toEqual([0xff, 0x7f]);
    expect([...leb128(16384)]).toEqual([0x80, 0x80, 0x01]);
  });

  it("rejects negative and non-integer inputs", () => {
    expect(() => leb128(-1)).toThrow();
    expect(() => leb128(1.5)).toThrow();
  });
});

describe("lvCat", () => {
  it("prefixes each value with its length", () => {
    expect([...prependLen(Uint8Array.from([1, 2, 3]))]).toEqual([3, 1, 2, 3]);
  });

  it("concatenates length-prefixed values in order", () => {
    const out = lvCat(Uint8Array.from([0xaa]), Uint8Array.from([0xbb, 0xcc]));
    expect([...out]).toEqual([1, 0xaa, 2, 0xbb, 0xcc]);
  });

  it("is unambiguous — different splits never collide", () => {
    const a = lvCat(Uint8Array.from([1, 2]), Uint8Array.from([3]));
    const b = lvCat(Uint8Array.from([1]), Uint8Array.from([2, 3]));
    expect(bytesToHex(a)).not.toBe(bytesToHex(b));
  });

  it("handles empty values", () => {
    expect([...lvCat(new Uint8Array(), Uint8Array.from([9]))]).toEqual([
      0, 1, 9,
    ]);
  });
});

describe("constantTimeEqual", () => {
  it("matches identical buffers", () => {
    expect(
      constantTimeEqual(Uint8Array.from([1, 2, 3]), Uint8Array.from([1, 2, 3])),
    ).toBe(true);
  });

  it("rejects a single differing byte anywhere", () => {
    const base = Uint8Array.from([1, 2, 3, 4]);
    for (let i = 0; i < base.length; i++) {
      const other = Uint8Array.from(base);
      other[i] = (other[i] ?? 0) ^ 0xff;
      expect(constantTimeEqual(base, other)).toBe(false);
    }
  });

  it("rejects differing lengths", () => {
    expect(
      constantTimeEqual(Uint8Array.from([1, 2]), Uint8Array.from([1, 2, 3])),
    ).toBe(false);
  });

  it("treats two empty buffers as equal", () => {
    expect(constantTimeEqual(new Uint8Array(), new Uint8Array())).toBe(true);
  });
});

describe("base64url", () => {
  it("round-trips every length from 0 to 64", () => {
    for (let n = 0; n <= 64; n++) {
      const bytes = randomBytes(n);
      const encoded = bytesToBase64Url(bytes);
      expect(bytesToHex(base64UrlToBytes(encoded))).toBe(bytesToHex(bytes));
    }
  });

  it("emits no padding and no URL-unsafe characters", () => {
    for (let n = 1; n <= 32; n++) {
      const encoded = bytesToBase64Url(randomBytes(n));
      expect(encoded).not.toContain("=");
      expect(encoded).not.toContain("+");
      expect(encoded).not.toContain("/");
      expect(encoded).toMatch(/^[A-Za-z0-9_-]*$/);
    }
  });

  it("matches known vectors", () => {
    expect(bytesToBase64Url(hexToBytes("00"))).toBe("AA");
    expect(bytesToBase64Url(hexToBytes("0001"))).toBe("AAE");
    expect(bytesToBase64Url(hexToBytes("000102"))).toBe("AAEC");
    expect(bytesToBase64Url(hexToBytes("fbff"))).toBe("-_8");
  });

  it("tolerates padding on the way in", () => {
    expect(bytesToHex(base64UrlToBytes("AAEC"))).toBe("000102");
    expect(bytesToHex(base64UrlToBytes("AAE="))).toBe("0001");
  });

  it("rejects invalid characters", () => {
    expect(() => base64UrlToBytes("AA*A")).toThrow(/invalid character/);
  });
});

describe("wipe", () => {
  it("zeroes the buffer in place", () => {
    const bytes = randomBytes(32);
    wipe(bytes);
    expect([...bytes].every((b) => b === 0)).toBe(true);
  });
});
