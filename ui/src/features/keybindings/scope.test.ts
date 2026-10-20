import { describe, expect, it } from "vitest";
import { focusStateOf, terminalHasFocus, textEntryHasFocus, type FocusElement } from "./scope";

function element(tagName: string, classes: string[] = [], over: Partial<FocusElement> = {}) {
  const set = new Set(classes);
  return { tagName, classList: { contains: (name: string) => set.has(name) }, ...over };
}

const xterm = element("TEXTAREA", ["xterm-helper-textarea"]);

describe("terminalHasFocus", () => {
  it("is the xterm helper textarea only", () => {
    expect(terminalHasFocus(xterm)).toBe(true);
    expect(terminalHasFocus(element("TEXTAREA"))).toBe(false);
    expect(terminalHasFocus(element("DIV", ["xterm"]))).toBe(false);
    expect(terminalHasFocus(null)).toBe(false);
  });
});

describe("textEntryHasFocus", () => {
  it("counts inputs, textareas, selects and contenteditable", () => {
    expect(textEntryHasFocus(element("INPUT"))).toBe(true);
    expect(textEntryHasFocus(element("INPUT", [], { type: "search" }))).toBe(true);
    expect(textEntryHasFocus(element("TEXTAREA"))).toBe(true);
    expect(textEntryHasFocus(element("SELECT"))).toBe(true);
    expect(textEntryHasFocus(element("DIV", [], { isContentEditable: true }))).toBe(true);
  });

  it("counts Monaco", () => {
    expect(textEntryHasFocus(element("TEXTAREA", ["inputarea", "monaco-mouse-cursor-text"]))).toBe(
      true,
    );
    expect(textEntryHasFocus(element("DIV", ["native-edit-context"]))).toBe(true);
  });

  it("leaves out the terminal, buttons and plain elements", () => {
    expect(textEntryHasFocus(xterm)).toBe(false);
    expect(textEntryHasFocus(element("INPUT", [], { type: "checkbox" }))).toBe(false);
    expect(textEntryHasFocus(element("BUTTON"))).toBe(false);
    expect(textEntryHasFocus(element("BODY"))).toBe(false);
    expect(textEntryHasFocus(undefined)).toBe(false);
  });
});

describe("focusStateOf", () => {
  it("reports both checks", () => {
    expect(focusStateOf(xterm)).toEqual({ terminal: true, textEntry: false });
    expect(focusStateOf(element("INPUT"))).toEqual({ terminal: false, textEntry: true });
    expect(focusStateOf(null)).toEqual({ terminal: false, textEntry: false });
  });
});
