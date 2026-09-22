import { describe, expect, it } from "vitest";
import {
  LOCAL_CODE_DIGITS,
  formatLocalCodeForDisplay,
  generateLocalCode,
  isLocalCode,
  normalizeLocalCode,
} from "./local-code";
import { parseCode } from "./pairing-code";

describe("local pairing codes", () => {
  it("generates six digits", () => {
    for (let i = 0; i < 200; i++) {
      const code = generateLocalCode();
      expect(code).toMatch(/^\d{6}$/);
      expect(code).toHaveLength(LOCAL_CODE_DIGITS);
    }
  });

  it("spreads over every digit rather than favouring the low ones", () => {
    // The whole point of rejection sampling. A `% 10` over a raw byte would
    // leave 6..9 at roughly three quarters of the frequency of 0..5, and this
    // catches that without being flaky: 12000 draws makes the gap enormous.
    const seen = new Map<string, number>();
    for (let i = 0; i < 2000; i++) {
      for (const digit of generateLocalCode()) {
        seen.set(digit, (seen.get(digit) ?? 0) + 1);
      }
    }
    expect(seen.size).toBe(10);
    for (const count of seen.values()) expect(count).toBeGreaterThan(800);
  });

  it("accepts the spacings people actually type", () => {
    expect(normalizeLocalCode("483 921")).toBe("483921");
    expect(normalizeLocalCode("483-921")).toBe("483921");
    expect(normalizeLocalCode(" 483921 ")).toBe("483921");
  });

  it("rejects anything that is not exactly six digits", () => {
    expect(normalizeLocalCode("48392")).toBeNull();
    expect(normalizeLocalCode("4839211")).toBeNull();
    expect(normalizeLocalCode("48392a")).toBeNull();
    expect(isLocalCode("492716384")).toBe(false);
  });

  it("cannot be confused with a broker code, in either direction", () => {
    // The one property that lets a single field take both forms.
    expect(parseCode(generateLocalCode())).toBeNull();
    expect(isLocalCode("492716384")).toBe(false);
  });

  it("groups for reading aloud", () => {
    expect(formatLocalCodeForDisplay("483921")).toBe("483 921");
    expect(() => formatLocalCodeForDisplay("4839")).toThrow();
  });
});
