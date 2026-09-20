import { describe, it, expect } from "vitest";
import {
  codeGroups,
  generateSecret,
  generateSlot,
  generateQrSlot,
  formatCode,
  formatCodeForDisplay,
  normalizeCode,
  parseCode,
  isValidSlot,
  isValidSecret,
  isValidLongSecret,
  generateLongSecret,
  formatLongCode,
  typedCodeLengths,
  LONG_SECRET_BYTES,
  LONG_SECRET_CHARS,
  QR_SLOT_COUNT,
  SECRET_COUNT,
  SLOT_COUNT,
} from "./pairing-code";

describe("code generation", () => {
  it("always produces exactly six secret digits, zeros included", () => {
    for (let i = 0; i < 500; i++) {
      expect(generateSecret()).toMatch(/^\d{6}$/);
    }
  });

  it("always produces exactly three slot digits", () => {
    for (let i = 0; i < 500; i++) {
      expect(generateSlot()).toMatch(/^\d{3}$/);
    }
  });

  it("always produces exactly four scan-slot digits", () => {
    for (let i = 0; i < 500; i++) {
      expect(generateQrSlot()).toMatch(/^\d{4}$/);
    }
  });

  it("keeps leading zeros rather than dropping them", () => {
    // Exhaustive coverage is out of reach at 10⁶, so this asks the question
    // that actually matters: does zero-padding survive? A dropped leading zero
    // would shorten the code and shrink the space it is drawn from.
    const seen = new Set<string>();
    for (let i = 0; i < 40_000; i++) seen.add(generateSecret());
    expect([...seen].every((s) => s.length === 6)).toBe(true);
    // ~4% of a million start with "00"; 40k draws make seeing one a certainty.
    expect([...seen].some((s) => s.startsWith("00"))).toBe(true);
    // And they must not all be distinct-by-luck only — no collapsed range.
    expect(seen.size).toBeGreaterThan(30_000);
  });

  it("is not obviously biased across the secret range", () => {
    // Rejection sampling should spread draws evenly over the four quartiles.
    const buckets = [0, 0, 0, 0];
    const draws = 20_000;
    for (let i = 0; i < draws; i++) {
      const value = Number(generateSecret());
      buckets[Math.floor((value / SECRET_COUNT) * 4)]!++;
    }
    for (const count of buckets) {
      expect(count).toBeGreaterThan(draws / 4 - draws / 20);
      expect(count).toBeLessThan(draws / 4 + draws / 20);
    }
  });

  it("is not obviously biased across the slot range", () => {
    const counts = new Map<string, number>();
    // Twenty draws per slot on average, which is what makes the statistic
    // below meaningful: the point is that no slot is systematically favoured,
    // which is what a `% SLOT_COUNT` fold would break.
    const draws = 20_000;
    for (let i = 0; i < draws; i++) {
      const slot = generateSlot();
      counts.set(slot, (counts.get(slot) ?? 0) + 1);
    }
    expect(counts.size).toBe(SLOT_COUNT);

    /*
     * One statistic over the whole distribution, not a band per slot.
     *
     * This used to assert `count > 20 / 4` for each of the thousand slots
     * independently. Each of those has a ~7.2e-5 chance of tripping on a
     * perfectly uniform generator, and a thousand of them compound: **7% of
     * runs failed**, on correct code. It duly took down a release. A test of
     * randomness that cries wolf one run in fourteen teaches people to re-run
     * CI until it passes, which is the opposite of what it is for.
     *
     * Pearson's chi-square with 999 degrees of freedom has mean 999 and
     * standard deviation √(2·999) ≈ 44.7. The threshold below is ten standard
     * deviations out — far beyond anything chance produces, and still nowhere
     * near what a generator favouring some slots over others would score.
     */
    const expected = draws / SLOT_COUNT;
    let chiSquare = 0;
    for (const count of counts.values()) {
      chiSquare += (count - expected) ** 2 / expected;
    }
    expect(chiSquare).toBeLessThan(SLOT_COUNT + 10 * Math.sqrt(2 * SLOT_COUNT));
  });
});

describe("validation", () => {
  it("accepts well-formed halves", () => {
    expect(isValidSlot("492")).toBe(true);
    expect(isValidSlot("000")).toBe(true);
    // The scan space is four digits wide and shares the same predicate.
    expect(isValidSlot("0492")).toBe(true);
    expect(isValidSecret("716384")).toBe(true);
    expect(isValidSecret("000000")).toBe(true);
  });

  it("rejects the wrong number of digits or non-digits", () => {
    // "49" and "2716" are the 0.6.x slot and secret. Both must now be refused
    // outright: a legacy code that half-parsed would derive a different key
    // from a code the user typed correctly, which reads as a wrong code.
    for (const bad of ["4", "49", "", "4a", " 92", "-92", "00492"]) {
      expect(isValidSlot(bad)).toBe(false);
    }
    for (const bad of ["2716", "716", "71638", "7163840", "", "71a384"]) {
      expect(isValidSecret(bad)).toBe(false);
    }
  });
});

describe("formatting", () => {
  it("joins the two halves in slot-then-secret order", () => {
    expect(formatCode("492", "716384")).toBe("492716384");
  });

  it("refuses to format malformed halves", () => {
    expect(() => formatCode("49", "716384")).toThrow(/slot/);
    expect(() => formatCode("492", "71638")).toThrow(/secret/);
  });

  it("groups a nine-digit code in even thirds", () => {
    // The leading group stays visually separate because it is the only part
    // that reaches our servers, and the copy everywhere leans on that.
    expect(formatCodeForDisplay("492716384")).toBe("492 716 384");
    expect(formatCodeForDisplay("492 716 384")).toBe("492 716 384");
    expect(codeGroups("492716384")).toEqual(["492", "716", "384"]);
  });

  it("refuses to display a code in a form we no longer mint", () => {
    // 0.6.x's eight-digit code, and its six-digit predecessor. Both are gone
    // as of 0.7.0 — the three-digit slot makes them unparseable rather than
    // merely old, which is the point of a clean break.
    expect(() => formatCodeForDisplay("49271638")).toThrow(
      /Invalid pairing code/,
    );
    expect(() => formatCodeForDisplay("492716")).toThrow(
      /Invalid pairing code/,
    );
  });
});

describe("parsing what a human actually types", () => {
  it("accepts spaces and dashes", () => {
    for (const input of [
      "492716384",
      "492 716 384",
      "492-716384",
      " 4 9 2 7 1 6 3 8 4 ",
    ]) {
      expect(parseCode(input)).toEqual({ slot: "492", secret: "716384" });
    }
  });

  it("accepts nine digits and nothing else", () => {
    expect(parseCode("492716384")).toEqual({ slot: "492", secret: "716384" });
    for (const bad of [
      "",
      // The 0.6.x eight-digit code and the 0.5 six-digit one. A clean break
      // means these are refused, not silently reinterpreted under a wider slot.
      "49271638",
      "492716",
      "4927163",
      "4927163845",
      "abcdefghi",
      "49271638.",
      "49_2716384",
    ]) {
      expect(parseCode(bad)).toBeNull();
      expect(normalizeCode(bad)).toBeNull();
    }
  });

  it("keeps leading zeros in both halves", () => {
    expect(parseCode("000000000")).toEqual({ slot: "000", secret: "000000" });
    expect(parseCode("010000023")).toEqual({ slot: "010", secret: "000023" });
  });

  it("round-trips generated codes", () => {
    for (let i = 0; i < 200; i++) {
      const slot = generateSlot();
      const secret = generateSecret();
      expect(parseCode(formatCode(slot, secret))).toEqual({ slot, secret });
    }
  });
});

describe("the form table", () => {
  it("gives every wire form a unique length", () => {
    // Length is the *only* thing telling the forms apart — there is no prefix
    // and no version byte. Two forms sharing a length would make a code
    // ambiguous, and the failure mode is a pairing that derives two different
    // keys from one correct code: indistinguishable from a wrong code.
    //
    // This is the assertion that forced the legacy forms out: a three-digit
    // typed slot gives 9 digits, which is unique, but only once the 24-char
    // legacy scan form and the 6-digit legacy typed form are gone.
    const codes = [
      formatCode("492", "716384"), // typed
      formatLongCode("0492", generateLongSecret()), // scan
    ];
    const lengths = codes.map((c) => c.length);
    expect(lengths).toEqual([9, 26]);
    expect(new Set(lengths).size).toBe(lengths.length);
  });

  it("parses each form back to the halves it was built from", () => {
    expect(parseCode(formatCode("492", "716384"))).toEqual({
      slot: "492",
      secret: "716384",
    });
    const long = generateLongSecret();
    expect(parseCode(formatLongCode("0492", long))).toEqual({
      slot: "0492",
      secret: long,
    });
  });

  it("reports the lengths it accepts, for error copy", () => {
    expect(typedCodeLengths()).toEqual([9]);
  });
});

describe("the long secret the QR carries", () => {
  it("is 22 base64url characters, and always exactly that", () => {
    for (let i = 0; i < 200; i++) {
      const secret = generateLongSecret();
      expect(secret).toHaveLength(LONG_SECRET_CHARS);
      expect(isValidLongSecret(secret)).toBe(true);
      // Unpadded: '=' would have to be escaped in a URL fragment.
      expect(secret).not.toContain("=");
    }
  });

  it("carries the full 128 bits", () => {
    // Not a distribution test — that is what a CSPRNG is for. This pins the
    // width, because silently generating fewer bytes here would weaken the
    // path most people use while every other test kept passing.
    expect(LONG_SECRET_BYTES).toBe(16);
    expect(LONG_SECRET_CHARS).toBe(Math.ceil((LONG_SECRET_BYTES * 4) / 3));

    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) seen.add(generateLongSecret());
    expect(seen.size).toBe(500);
  });

  it("rejects anything that is not the exact shape", () => {
    for (const bad of [
      "",
      "short",
      "A".repeat(LONG_SECRET_CHARS - 1),
      "A".repeat(LONG_SECRET_CHARS + 1),
      // '+' and '/' are base64, not base64url — they would need escaping.
      `${"A".repeat(LONG_SECRET_CHARS - 1)}+`,
      `${"A".repeat(LONG_SECRET_CHARS - 1)}/`,
    ]) {
      expect(isValidLongSecret(bad)).toBe(false);
    }
  });

  it("round-trips through parseCode alongside the typed form", () => {
    for (let i = 0; i < 200; i++) {
      const slot = generateQrSlot();
      const secret = generateLongSecret();
      expect(parseCode(formatLongCode(slot, secret))).toEqual({ slot, secret });
    }
  });

  it("draws its slot from the whole four-digit space", () => {
    // The scan space is 5× the typed one, and drawn separately, which is what
    // stops a sweep of the typed space from touching a scanned pairing at all.
    //
    // Not coupon-collector — that would need ~92k draws. 40k over 10k values
    // covers 1-e⁻⁴ ≈ 98% of the space, and a generator that had quietly
    // collapsed to a narrower range could not reach anywhere near it.
    const seen = new Set<string>();
    for (let i = 0; i < 40_000; i++) seen.add(generateQrSlot());
    expect(seen.size).toBeGreaterThan(QR_SLOT_COUNT * 0.97);
    expect([...seen].some((s) => s.startsWith("00"))).toBe(true);
    expect([...seen].every((s) => s.length === 4)).toBe(true);
  });

  it("never mangles a secret containing a dash", () => {
    // The whole reason the long form skips `normalizeCode`: '-' is a base64url
    // character, and stripping it as punctuation would corrupt roughly one
    // secret in eight while looking like a wrong code.
    const secret = `-${"A".repeat(LONG_SECRET_CHARS - 2)}-`;
    expect(isValidLongSecret(secret)).toBe(true);
    expect(parseCode(`0492${secret}`)).toEqual({ slot: "0492", secret });
  });

  it("still rejects the shapes that are neither form", () => {
    for (const bad of ["492", "4".repeat(23), `0492${"A".repeat(21)}`]) {
      expect(parseCode(bad)).toBeNull();
    }
  });

  it("refuses to format a malformed long code", () => {
    expect(() => formatLongCode("4", generateLongSecret())).toThrow();
    expect(() => formatLongCode("0492", "too-short")).toThrow();
  });
});
