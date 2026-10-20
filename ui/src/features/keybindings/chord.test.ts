import { describe, expect, it } from "vitest";
import {
  chordFromEvent,
  chordKey,
  formatChord,
  parseChord,
  type Chord,
  type ChordEvent,
} from "./chord";

function chord(text: string, platform: "mac" | "other" = "other"): Chord {
  const parsed = parseChord(text, platform);
  if (!parsed.ok) throw new Error(`${text}: ${parsed.error}`);
  return parsed.chord;
}

function error(text: string): string {
  const parsed = parseChord(text, "other");
  if (parsed.ok) throw new Error(`${text} parsed`);
  return parsed.error;
}

function press(over: Partial<ChordEvent>): ChordEvent {
  return {
    key: "",
    code: "",
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    ...over,
  };
}

describe("parseChord", () => {
  it("reads modifiers and one key", () => {
    expect(chord("ctrl+shift+k")).toEqual({
      ctrl: true,
      shift: true,
      alt: false,
      cmd: false,
      key: "k",
    });
    expect(chord("k")).toEqual({ ctrl: false, shift: false, alt: false, cmd: false, key: "k" });
  });

  it("accepts every key name of the grammar", () => {
    const keys = [
      "a",
      "z",
      "0",
      "9",
      "f1",
      "f12",
      "enter",
      "escape",
      "space",
      "tab",
      "backspace",
      "delete",
      "up",
      "down",
      "left",
      "right",
      "home",
      "end",
      "pageup",
      "pagedown",
      "-",
      "=",
      "[",
      "]",
      "`",
      "/",
      "\\",
      ",",
      ".",
      ";",
      "'",
    ];
    for (const key of keys) expect(chord(`ctrl+${key}`).key).toBe(key);
  });

  it("maps cmd aliases to cmd", () => {
    for (const alias of ["cmd", "meta", "super", "win"]) {
      expect(chord(`${alias}+k`).cmd).toBe(true);
    }
  });

  it("counts two names for one modifier once, as the hub does", () => {
    expect(chordKey(chord("cmd+meta+k"))).toBe("cmd+k");
    expect(chordKey(chord("alt+meta+super+win+f12"))).toBe("alt+cmd+f12");
    expect(chordKey(chord("mod+ctrl+k", "other"))).toBe("ctrl+k");
    expect(chordKey(chord("mod+ctrl+k", "mac"))).toBe("ctrl+cmd+k");
    expect(chordKey(chord("cmd+mod+k", "mac"))).toBe("cmd+k");
    expect(chordKey(chord("ctrl+shift+alt+cmd+meta+super+win+mod+pagedown", "other"))).toBe(
      "ctrl+shift+alt+cmd+pagedown",
    );
  });

  it("resolves mod per platform and never stores it", () => {
    expect(chord("mod+k", "other")).toMatchObject({ ctrl: true, cmd: false });
    expect(chord("mod+k", "mac")).toMatchObject({ ctrl: false, cmd: true });
    expect(Object.keys(chord("mod+k"))).not.toContain("mod");
  });

  it("rejects spaces, unknown tokens, missing keys and repeats", () => {
    expect(error("ctrl + k")).toMatch(/Spaces/);
    expect(error("ctrl k")).toMatch(/Spaces/);
    expect(error("hyper+k")).toMatch(/Unknown modifier/);
    expect(error("ctrl+f13")).toMatch(/Unknown key/);
    expect(error("ctrl+plus")).toMatch(/Unknown key/);
    expect(error("ctrl+shift")).toMatch(/Missing key/);
    expect(error("ctrl+")).toMatch(/Missing key/);
    expect(error("+")).toMatch(/Empty part|Missing key/);
    expect(error("ctrl++k")).toMatch(/Empty part/);
    expect(error("a+b")).toMatch(/Only one key/);
    expect(error("ctrl+ctrl+k")).toMatch(/repeated/);
    expect(error("meta+meta+k")).toMatch(/repeated/);
    expect(error("mod+shift+mod+k")).toMatch(/repeated/);
    expect(error("Ctrl+K")).toMatch(/lower case/);
    expect(error("")).toMatch(/empty/);
    expect(error(`ctrl+${"a".repeat(64)}`)).toMatch(/longer/);
  });
});

describe("chordKey", () => {
  it("is the same for any modifier order", () => {
    expect(chordKey(chord("shift+ctrl+k"))).toBe("ctrl+shift+k");
    expect(chordKey(chord("cmd+alt+shift+ctrl+/"))).toBe("ctrl+shift+alt+cmd+/");
    expect(chordKey(chord("super+k"))).toBe(chordKey(chord("cmd+k")));
  });
});

describe("formatChord", () => {
  it("uses symbols in Apple order on Mac", () => {
    expect(formatChord(chord("cmd+shift+f"), "mac")).toBe("⇧⌘F");
    expect(formatChord(chord("cmd+k"), "mac")).toBe("⌘K");
    expect(formatChord(chord("ctrl+shift+space"), "mac")).toBe("⌃⇧Space");
    expect(formatChord(chord("alt+cmd+enter"), "mac")).toBe("⌥⌘↵");
  });

  it("uses words elsewhere, joined like the palette hints", () => {
    expect(formatChord(chord("ctrl+shift+f"), "other")).toBe("Ctrl Shift F");
    expect(formatChord(chord("ctrl+k"), "other")).toBe("Ctrl K");
    expect(formatChord(chord("ctrl+alt+="), "other")).toBe("Ctrl Alt =");
    expect(formatChord(chord("shift+/"), "other")).toBe("Shift /");
    expect(formatChord(chord("ctrl+enter"), "other")).toBe("Ctrl Enter");
    expect(formatChord(chord("f5"), "other")).toBe("F5");
  });
});

describe("chordFromEvent", () => {
  const keyOf = (over: Partial<ChordEvent>) => {
    const result = chordFromEvent(press(over));
    return result && chordKey(result);
  };

  it("reads letters and digits from event.code", () => {
    expect(keyOf({ key: "K", code: "KeyK", ctrlKey: true, shiftKey: true })).toBe("ctrl+shift+k");
    // Option on a Mac changes event.key, not the code.
    expect(keyOf({ key: "˚", code: "KeyK", altKey: true })).toBe("alt+k");
    expect(keyOf({ key: ")", code: "Digit0", ctrlKey: true, shiftKey: true })).toBe("ctrl+shift+0");
    expect(keyOf({ key: "k", code: "KeyK", metaKey: true })).toBe("cmd+k");
  });

  it("reads punctuation from event.code when Option changed event.key", () => {
    expect(keyOf({ key: "“", code: "BracketLeft", altKey: true, metaKey: true })).toBe("alt+cmd+[");
    expect(keyOf({ key: "‘", code: "BracketRight", altKey: true, metaKey: true })).toBe(
      "alt+cmd+]",
    );
    expect(keyOf({ key: "”", code: "BracketLeft", altKey: true, shiftKey: true })).toBe(
      "shift+alt+[",
    );
    expect(keyOf({ key: "Dead", code: "Backquote", altKey: true })).toBe("alt+`");
    // Without Alt, event.key decides, as before.
    expect(keyOf({ key: "ü", code: "BracketLeft", ctrlKey: true })).toBeNull();
  });

  it("makes shift+/ from a question mark, like the shortcuts default", () => {
    expect(keyOf({ key: "?", code: "Slash", shiftKey: true })).toBe(chordKey(chord("shift+/")));
  });

  it("reads Ctrl with = and Ctrl with + as zoom in chords", () => {
    expect(keyOf({ key: "=", code: "Equal", ctrlKey: true })).toBe(chordKey(chord("ctrl+=")));
    expect(keyOf({ key: "+", code: "Equal", ctrlKey: true, shiftKey: true })).toBe(
      chordKey(chord("ctrl+shift+=")),
    );
    // A layout or numpad that types + without Shift.
    expect(keyOf({ key: "+", code: "NumpadAdd", ctrlKey: true })).toBe("ctrl+shift+=");
    expect(keyOf({ key: "-", code: "Minus", ctrlKey: true })).toBe("ctrl+-");
  });

  it("names the special keys", () => {
    expect(keyOf({ key: " ", code: "Space", ctrlKey: true, shiftKey: true })).toBe(
      "ctrl+shift+space",
    );
    expect(keyOf({ key: "Enter", code: "Enter", metaKey: true })).toBe("cmd+enter");
    expect(keyOf({ key: "ArrowUp", code: "ArrowUp", altKey: true })).toBe("alt+up");
    expect(keyOf({ key: "F5", code: "F5" })).toBe("f5");
    expect(keyOf({ key: "PageDown", code: "PageDown" })).toBe("pagedown");
    expect(keyOf({ key: "Escape", code: "Escape" })).toBe("escape");
  });

  it("returns null for bare modifiers and unknown keys", () => {
    for (const key of ["Control", "Shift", "Alt", "Meta", "AltGraph", "CapsLock"]) {
      expect(chordFromEvent(press({ key, ctrlKey: key === "Control" }))).toBeNull();
    }
    expect(chordFromEvent(press({ key: "Dead", code: "Quote" }))).toBeNull();
    expect(chordFromEvent(press({ key: "Unidentified" }))).toBeNull();
    expect(chordFromEvent(press({ key: "Process", code: "KeyA" }))).toBeNull();
    // A dead key on a letter, such as Option with E on a Mac, still has its code.
    expect(keyOf({ key: "Dead", code: "KeyE", altKey: true })).toBe("alt+e");
    expect(chordFromEvent({ ...press({}), key: undefined } as unknown as ChordEvent)).toBeNull();
  });
});
