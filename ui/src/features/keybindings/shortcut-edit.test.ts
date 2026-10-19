import { describe, expect, it } from "vitest";
import { parseChord, type Chord } from "./chord";
import { chordSpeech } from "./chord-speech";
import type { CommandId } from "./command-ids";
import { DEFAULT_KEYBINDINGS } from "./default-keybindings";
import { parseKeybindingsDocument } from "./keybindings-store";
import { resolveKeymap, type Keymap } from "./keymap";
import type { Platform } from "./platform";
import {
  BROKEN_DOCUMENT,
  applyShortcutChange,
  changedCommands,
  defaultScope,
  entryCount,
  isBrowserReserved,
  primaryBinding,
  recorderKey,
  removeShortcut,
  resetCommandEntries,
  shortcutConflicts,
  takesKeyFromShell,
} from "./shortcut-edit";

function chord(text: string, platform: Platform = "other"): Chord {
  const parsed = parseChord(text, platform);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.chord;
}

function keymapOf(text: string, platform: Platform): Keymap {
  return resolveKeymap(DEFAULT_KEYBINDINGS, parseKeybindingsDocument(text).entries, platform);
}

function edited(text: string): unknown[] {
  return JSON.parse(text) as unknown[];
}

function event(
  key: string,
  code: string,
  mods: Partial<Record<"ctrl" | "shift" | "alt" | "meta", boolean>> = {},
) {
  return {
    key,
    code,
    ctrlKey: !!mods.ctrl,
    shiftKey: !!mods.shift,
    altKey: !!mods.alt,
    metaKey: !!mods.meta,
  };
}

describe("applyShortcutChange", () => {
  it("replaces a default with a removal and a new entry", () => {
    const keymap = keymapOf("[]", "other");
    const replacing = primaryBinding(keymap, "sidebar.toggle");
    expect(replacing).toMatchObject({ chordKey: "ctrl+b", scope: "app", source: "default" });
    const result = applyShortcutChange(
      "[]",
      { command: "sidebar.toggle", chord: chord("ctrl+shift+b"), scope: "app", replacing },
      "other",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(edited(result.text)).toEqual([
      { key: "ctrl+b", command: "-sidebar.toggle" },
      { key: "ctrl+shift+b", command: "sidebar.toggle", scope: "app" },
    ]);
    expect(result.text.endsWith("\n")).toBe(true);
    const next = keymapOf(result.text, "other");
    expect(next.bindingsFor("sidebar.toggle").map((b) => b.chordKey)).toEqual(["ctrl+shift+b"]);
  });

  it("writes the mac field on a Mac", () => {
    const keymap = keymapOf("[]", "mac");
    const replacing = primaryBinding(keymap, "palette.commands");
    expect(replacing?.chordKey).toBe("cmd+k");
    const result = applyShortcutChange(
      "[]",
      { command: "palette.commands", chord: chord("cmd+j", "mac"), scope: "global", replacing },
      "mac",
    );
    expect(result.ok && edited(result.text)).toEqual([
      { mac: "cmd+k", command: "-palette.commands" },
      { mac: "cmd+j", command: "palette.commands", scope: "global" },
    ]);
  });

  it("replaces its own earlier entry instead of piling up", () => {
    let text = "[]";
    for (const next of ["ctrl+shift+b", "ctrl+alt+b", "ctrl+shift+y"]) {
      const replacing = primaryBinding(keymapOf(text, "other"), "sidebar.toggle");
      const result = applyShortcutChange(
        text,
        { command: "sidebar.toggle", chord: chord(next), scope: "app", replacing },
        "other",
      );
      if (!result.ok) throw new Error(result.error);
      text = result.text;
    }
    expect(edited(text)).toEqual([
      { key: "ctrl+b", command: "-sidebar.toggle" },
      { key: "ctrl+shift+y", command: "sidebar.toggle", scope: "app" },
    ]);
  });

  it("changing back to the default leaves an empty document", () => {
    const first = applyShortcutChange(
      "[]",
      {
        command: "lock.now",
        chord: chord("ctrl+alt+l"),
        scope: "global",
        replacing: primaryBinding(keymapOf("[]", "other"), "lock.now"),
      },
      "other",
    );
    if (!first.ok) throw new Error(first.error);
    const back = applyShortcutChange(
      first.text,
      {
        command: "lock.now",
        chord: chord("ctrl+shift+l"),
        scope: "global",
        replacing: primaryBinding(keymapOf(first.text, "other"), "lock.now"),
      },
      "other",
    );
    expect(back.ok && edited(back.text)).toEqual([]);
  });

  it("leaves hand written entries alone and keeps args", () => {
    const text = JSON.stringify([
      { key: "ctrl+j", mac: "cmd+j", command: "palette.open", args: { mode: "files" } },
    ]);
    const replacing = primaryBinding(keymapOf(text, "other"), "palette.open");
    expect(replacing?.args).toEqual({ mode: "files" });
    const result = applyShortcutChange(
      text,
      { command: "palette.open", chord: chord("ctrl+shift+j"), scope: "global", replacing },
      "other",
    );
    expect(result.ok && edited(result.text)).toEqual([
      { key: "ctrl+j", mac: "cmd+j", command: "palette.open", args: { mode: "files" } },
      { key: "ctrl+j", command: "-palette.open" },
      { key: "ctrl+shift+j", command: "palette.open", scope: "global", args: { mode: "files" } },
    ]);
  });

  it("adds a binding to a command without one", () => {
    const result = applyShortcutChange(
      "",
      { command: "tmux.newWindow", chord: chord("ctrl+alt+n"), scope: "global" },
      "other",
    );
    expect(result.ok && edited(result.text)).toEqual([
      { key: "ctrl+alt+n", command: "tmux.newWindow", scope: "global" },
    ]);
  });

  it("refuses a document that is not a JSON array", () => {
    for (const text of ["{", "{}", "1"]) {
      expect(
        applyShortcutChange(
          text,
          { command: "lock.now", chord: chord("ctrl+l"), scope: "global" },
          "other",
        ),
      ).toEqual({ ok: false, error: BROKEN_DOCUMENT });
    }
  });

  it("refuses to grow past the entry limit", () => {
    const full = JSON.stringify(
      Array.from({ length: 512 }, (_, i) => ({
        key: `ctrl+f${(i % 12) + 1}`,
        command: "lock.now",
      })),
    );
    const result = applyShortcutChange(
      full,
      { command: "tmux.detach", chord: chord("ctrl+alt+d"), scope: "global" },
      "other",
    );
    expect(result.ok).toBe(false);
  });
});

describe("removeShortcut", () => {
  /** Remove the command's primary binding, as the settings row does. */
  function removePrimary(text: string, command: CommandId, platform: Platform = "other") {
    const binding = primaryBinding(keymapOf(text, platform), command);
    if (!binding) throw new Error(`${command} has no shortcut`);
    return removeShortcut(text, { command, binding }, platform);
  }

  it("drops the entry that added the shortcut", () => {
    const text = JSON.stringify([
      { key: "ctrl+alt+n", command: "tmux.newWindow", scope: "global" },
      { key: "ctrl+alt+l", command: "lock.now" },
    ]);
    const result = removePrimary(text, "tmux.newWindow");
    if (!result.ok) throw new Error(result.error);
    expect(edited(result.text)).toEqual([{ key: "ctrl+alt+l", command: "lock.now" }]);
    expect(keymapOf(result.text, "other").bindingsFor("tmux.newWindow")).toEqual([]);
  });

  it("writes a removal entry for a default", () => {
    const result = removePrimary("[]", "sidebar.toggle");
    if (!result.ok) throw new Error(result.error);
    expect(edited(result.text)).toEqual([{ key: "ctrl+b", command: "-sidebar.toggle" }]);
    expect(result.text.endsWith("\n")).toBe(true);
    expect(keymapOf(result.text, "other").bindingsFor("sidebar.toggle")).toEqual([]);
    // Reset brings the default back.
    const reset = resetCommandEntries(result.text, "sidebar.toggle");
    expect(reset.ok && keymapOf(reset.text, "other").bindingsFor("sidebar.toggle")).toHaveLength(1);
  });

  it("writes the mac field on a Mac", () => {
    const result = removePrimary("", "palette.commands", "mac");
    expect(result.ok && edited(result.text)).toEqual([
      { mac: "cmd+k", command: "-palette.commands" },
    ]);
  });

  it("keeps the removal of a default the user replaced", () => {
    const text = JSON.stringify([
      { key: "ctrl+b", command: "-sidebar.toggle" },
      { key: "ctrl+shift+b", command: "sidebar.toggle", scope: "app" },
    ]);
    const result = removePrimary(text, "sidebar.toggle");
    if (!result.ok) throw new Error(result.error);
    expect(edited(result.text)).toEqual([{ key: "ctrl+b", command: "-sidebar.toggle" }]);
    expect(keymapOf(result.text, "other").bindingsFor("sidebar.toggle")).toEqual([]);
  });

  it("takes off the primary shortcut and keeps the others", () => {
    const before = keymapOf("[]", "other").bindingsFor("terminal.zoomIn");
    expect(before.map((b) => b.chordKey)).toEqual(["ctrl+=", "ctrl+shift+="]);
    const result = removePrimary("[]", "terminal.zoomIn");
    if (!result.ok) throw new Error(result.error);
    expect(edited(result.text)).toEqual([{ key: "ctrl+=", command: "-terminal.zoomIn" }]);
    const after = keymapOf(result.text, "other").bindingsFor("terminal.zoomIn");
    expect(after.map((b) => b.chordKey)).toEqual(["ctrl+shift+="]);
  });

  it("leaves a hand written entry and removes its chord after it", () => {
    const entry = { key: "ctrl+j", mac: "cmd+j", command: "palette.open", args: { mode: "files" } };
    const result = removePrimary(JSON.stringify([entry]), "palette.open");
    if (!result.ok) throw new Error(result.error);
    expect(edited(result.text)).toEqual([entry, { key: "ctrl+j", command: "-palette.open" }]);
    expect(keymapOf(result.text, "other").bindingsFor("palette.open")).toEqual([]);
    // The Mac chord of the entry still works there.
    expect(keymapOf(result.text, "mac").bindingsFor("palette.open")).toHaveLength(1);
  });

  it("refuses a document that is not a JSON array", () => {
    const binding = primaryBinding(keymapOf("[]", "other"), "lock.now");
    if (!binding) throw new Error("lock.now has no default");
    for (const text of ["{", "{}", "1"]) {
      expect(removeShortcut(text, { command: "lock.now", binding }, "other")).toEqual({
        ok: false,
        error: BROKEN_DOCUMENT,
      });
    }
  });
});

describe("resetCommandEntries and changedCommands", () => {
  const text = JSON.stringify([
    { key: "ctrl+b", command: "-sidebar.toggle" },
    { key: "ctrl+shift+b", command: "sidebar.toggle" },
    { key: "ctrl+alt+l", command: "lock.now" },
    "not an entry",
  ]);

  it("lists commands with entries, removals included", () => {
    expect([...changedCommands(text)].sort()).toEqual(["lock.now", "sidebar.toggle"]);
    expect(changedCommands("{").size).toBe(0);
    expect(entryCount(text)).toBe(4);
    expect(entryCount("{}")).toBeNull();
  });

  it("drops only that command's entries", () => {
    const result = resetCommandEntries(text, "sidebar.toggle");
    expect(result.ok && edited(result.text)).toEqual([
      { key: "ctrl+alt+l", command: "lock.now" },
      "not an entry",
    ]);
    expect(resetCommandEntries("{", "lock.now").ok).toBe(false);
  });
});

describe("recorder checks", () => {
  it("names other commands on the chord where scopes overlap", () => {
    const keymap = keymapOf("[]", "other");
    expect(shortcutConflicts(keymap, chord("ctrl+k"), "global", "lock.now")).toEqual([
      "palette.commands",
    ]);
    // Ctrl+B runs the sidebar outside the terminal only.
    expect(shortcutConflicts(keymap, chord("ctrl+b"), "terminal", "lock.now")).toEqual([]);
    expect(shortcutConflicts(keymap, chord("ctrl+b"), "app", "sidebar.toggle")).toEqual([]);
  });

  it("warns on keys the browser keeps", () => {
    expect(isBrowserReserved(chord("ctrl+w"), "other")).toBe(true);
    expect(isBrowserReserved(chord("ctrl+shift+t"), "other")).toBe(true);
    expect(isBrowserReserved(chord("cmd+q", "mac"), "mac")).toBe(true);
    expect(isBrowserReserved(chord("ctrl+w", "mac"), "mac")).toBe(false);
    expect(isBrowserReserved(chord("ctrl+alt+w"), "other")).toBe(false);
    expect(isBrowserReserved(chord("ctrl+k"), "other")).toBe(false);
  });

  it("starts plain keys outside the terminal", () => {
    expect(defaultScope(chord("shift+/"))).toBe("app");
    expect(defaultScope(chord("ctrl+k"))).toBe("global");
    expect(defaultScope(chord("ctrl+k"), { scope: "terminal" })).toBe("terminal");
    expect(takesKeyFromShell(chord("f5"), "global")).toBe(true);
    expect(takesKeyFromShell(chord("f5"), "app")).toBe(false);
    expect(takesKeyFromShell(chord("ctrl+f5"), "global")).toBe(false);
  });

  it("reads recorder keys", () => {
    expect(recorderKey(event("Tab", "Tab"), true)).toEqual({ kind: "pass" });
    expect(recorderKey(event("Tab", "Tab", { shift: true }), false)).toEqual({ kind: "pass" });
    expect(recorderKey(event("Escape", "Escape"), true)).toEqual({ kind: "cancel" });
    expect(recorderKey(event("Enter", "Enter"), true)).toEqual({ kind: "save" });
    expect(recorderKey(event("Enter", "Enter"), false)).toMatchObject({ kind: "chord" });
    expect(recorderKey(event("Control", "ControlLeft", { ctrl: true }), false)).toEqual({
      kind: "ignore",
    });
    expect(recorderKey({ ...event("k", "KeyK", { ctrl: true }), repeat: true }, false)).toEqual({
      kind: "ignore",
    });
    expect(recorderKey({ ...event("k", "KeyK"), isComposing: true }, false)).toEqual({
      kind: "pass",
    });
    expect(recorderKey(event("K", "KeyK", { ctrl: true, shift: true }), false)).toEqual({
      kind: "chord",
      chord: chord("ctrl+shift+k"),
    });
    // Ctrl+Tab and Ctrl+Escape are chords, not focus moves or cancels.
    expect(recorderKey(event("Tab", "Tab", { ctrl: true }), false)).toMatchObject({
      kind: "chord",
    });
    expect(recorderKey(event("Escape", "Escape", { ctrl: true }), false)).toMatchObject({
      kind: "chord",
    });
  });
});

describe("chordSpeech", () => {
  it("says modifiers and keys in words", () => {
    expect(chordSpeech(chord("cmd+shift+f", "mac"), "mac")).toBe("Shift Command F");
    expect(chordSpeech(chord("ctrl+alt+="), "other")).toBe("Control Alt Equals");
    expect(chordSpeech(chord("shift+/"), "other")).toBe("Shift Slash");
  });
});
