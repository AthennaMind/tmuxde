import { describe, expect, it } from "vitest";
import { decodeOsc52 } from "./osc52";

const encode = (text: string) => Buffer.from(text).toString("base64");

describe("OSC 52 clipboard writes", () => {
  it.each(["", "c", "p", "s0", "cp"])("decodes target %s", (target) => {
    const text = "selected text\nsecond line";
    expect(decodeOsc52(`${target};${encode(text)}`)).toBe(text);
  });

  it("preserves UTF-8 text", () => {
    const text = "café 世界";
    expect(decodeOsc52(`c;${encode(text)}`)).toBe(text);
  });

  it.each(["c;?", ";?", "c;", "", "Y29weQ==", "x;Y29weQ==", "c;%%%", "c;/w=="])(
    "ignores queries, empty writes and malformed data: %s",
    (data) => expect(decodeOsc52(data)).toBeNull(),
  );

  it("rejects oversized writes", () => {
    expect(decodeOsc52(`c;${encode("x".repeat(1024 * 1024 + 1))}`)).toBeNull();
  });
});
