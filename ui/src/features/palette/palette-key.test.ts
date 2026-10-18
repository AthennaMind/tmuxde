import { expect, it } from "vitest";
import { isPaletteKey, paletteKeyMode } from "./palette-key";

const base = { key: "k", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false };

it("maps the three palette shortcuts and leaves shell combinations alone", () => {
  expect(paletteKeyMode(base)).toBeNull();
  expect(paletteKeyMode({ ...base, ctrlKey: true })).toBe("commands");
  expect(paletteKeyMode({ ...base, key: "K", metaKey: true })).toBe("commands");
  expect(paletteKeyMode({ ...base, key: "p", ctrlKey: true })).toBe("files");
  expect(paletteKeyMode({ ...base, key: "F", ctrlKey: true, shiftKey: true })).toBe("terminals");
  expect(paletteKeyMode({ ...base, key: "f", ctrlKey: true })).toBeNull();
  expect(paletteKeyMode({ ...base, key: "p", ctrlKey: true, shiftKey: true })).toBeNull();
  expect(paletteKeyMode({ ...base, ctrlKey: true, altKey: true })).toBeNull();
  expect(isPaletteKey({ ...base, key: "c", ctrlKey: true })).toBe(false);
});
