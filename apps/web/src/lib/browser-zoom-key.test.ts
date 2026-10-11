import { describe, expect, it } from "vitest";
import { isBrowserZoomKey } from "./browser-zoom-key.js";

const key = (
  k: string,
  mods: Partial<Record<"ctrlKey" | "metaKey" | "altKey", boolean>> = {},
) => ({ key: k, ctrlKey: false, metaKey: false, altKey: false, ...mods });

describe("isBrowserZoomKey", () => {
  it("leaves Ctrl and Cmd zoom keys to the browser", () => {
    for (const k of ["-", "=", "+", "0"]) {
      expect(isBrowserZoomKey(key(k, { ctrlKey: true }))).toBe(true);
      expect(isBrowserZoomKey(key(k, { metaKey: true }))).toBe(true);
    }
  });

  it("keeps readline undo and plain typing in the terminal", () => {
    expect(isBrowserZoomKey(key("_", { ctrlKey: true }))).toBe(false);
    expect(isBrowserZoomKey(key("-"))).toBe(false);
    expect(isBrowserZoomKey(key("c", { ctrlKey: true }))).toBe(false);
  });

  it("ignores Alt combinations", () => {
    expect(isBrowserZoomKey(key("-", { ctrlKey: true, altKey: true }))).toBe(
      false,
    );
  });
});
