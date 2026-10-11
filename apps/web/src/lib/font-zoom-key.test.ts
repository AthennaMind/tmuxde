import { describe, expect, it } from "vitest";
import { fontZoomStep, isFontZoomKey } from "./font-zoom-key.js";

const key = (
  k: string,
  mods: Partial<Record<"ctrlKey" | "metaKey" | "altKey", boolean>> = {},
) => ({ key: k, ctrlKey: false, metaKey: false, altKey: false, ...mods });

describe("fontZoomStep", () => {
  it("reads Ctrl and Cmd zoom keys as steps", () => {
    for (const mods of [{ ctrlKey: true }, { metaKey: true }]) {
      expect(fontZoomStep(key("=", mods))).toBe(1);
      expect(fontZoomStep(key("+", mods))).toBe(1);
      expect(fontZoomStep(key("-", mods))).toBe(-1);
      expect(fontZoomStep(key("0", mods))).toBe(0);
    }
  });

  it("keeps readline undo and plain typing in the terminal", () => {
    expect(isFontZoomKey(key("_", { ctrlKey: true }))).toBe(false);
    expect(isFontZoomKey(key("-"))).toBe(false);
    expect(isFontZoomKey(key("c", { ctrlKey: true }))).toBe(false);
  });

  it("ignores Alt combinations", () => {
    expect(isFontZoomKey(key("-", { ctrlKey: true, altKey: true }))).toBe(
      false,
    );
  });
});
