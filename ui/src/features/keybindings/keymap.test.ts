import { describe, expect, it } from "vitest";
import { chordKey, parseChord } from "./chord";
import { isCommandId } from "./command-ids";
import { DEFAULT_KEYBINDINGS, DEFAULT_KEYBINDINGS_COUNT } from "./default-keybindings";
import { resolveKeymap, type KeybindingEntry, type Keymap } from "./keymap";
import type { Platform } from "./platform";
import { shortcutLabel } from "./shortcut-label";

function key(text: string, platform: Platform = "other"): string {
  const parsed = parseChord(text, platform);
  if (!parsed.ok) throw new Error(parsed.error);
  return chordKey(parsed.chord);
}

/** Commands on a chord, the winner first. */
function on(keymap: Keymap, text: string): string[] {
  return (keymap.lookup.get(key(text, keymap.platform)) ?? []).map((binding) => binding.command);
}

const resolve = (user: KeybindingEntry[], platform: Platform = "other") =>
  resolveKeymap(DEFAULT_KEYBINDINGS, user, platform);

describe("defaults", () => {
  it("has the plan's sixteen entries with known commands", () => {
    expect(DEFAULT_KEYBINDINGS_COUNT).toBe(16);
    expect(DEFAULT_KEYBINDINGS.every((entry) => isCommandId(entry.command))).toBe(true);
  });

  it("resolves without issues or conflicts on both platforms", () => {
    for (const platform of ["mac", "other"] as const) {
      const keymap = resolve([], platform);
      expect(keymap.issues).toEqual([]);
      expect(keymap.conflicts).toEqual([]);
      expect(keymap.unknownCommands).toEqual([]);
    }
  });

  it("keeps Ctrl outside the terminal on Linux and Windows", () => {
    const keymap = resolve([]);
    expect(on(keymap, "ctrl+k")).toEqual(["palette.commands"]);
    expect(on(keymap, "ctrl+b")).toEqual(["sidebar.toggle"]);
    expect(keymap.lookup.get(key("ctrl+b"))?.[0]?.scope).toBe("app");
    expect(on(keymap, "cmd+b")).toEqual([]);
    expect(on(keymap, "ctrl+=")).toEqual(["terminal.zoomIn"]);
    expect(on(keymap, "ctrl+shift+=")).toEqual(["terminal.zoomIn"]);
    expect(on(keymap, "shift+/")).toEqual(["shortcuts.open"]);
  });

  it("gives Mac Cmd variants everywhere and Ctrl+K back to the shell", () => {
    const keymap = resolve([], "mac");
    expect(on(keymap, "cmd+k")).toEqual(["palette.commands"]);
    expect(on(keymap, "ctrl+k")).toEqual([]);
    expect(on(keymap, "ctrl+p")).toEqual([]);
    expect(on(keymap, "cmd+b")).toEqual(["sidebar.toggle"]);
    expect(keymap.lookup.get(key("cmd+b", "mac"))?.[0]?.scope).toBe("global");
    // Ctrl+B, E and O stay with text fields and Monaco, which move the cursor.
    expect(on(keymap, "ctrl+b")).toEqual([]);
    expect(on(keymap, "ctrl+e")).toEqual([]);
    expect(on(keymap, "ctrl+o")).toEqual([]);
    expect(keymap.bindingsFor("sidebar.files").map((binding) => binding.chordKey)).toEqual([
      "cmd+e",
    ]);
    // Entries with only `key` apply on Mac too.
    expect(on(keymap, "ctrl+shift+space")).toEqual(["dictation.toggle"]);
    expect(on(keymap, "shift+/")).toEqual(["shortcuts.open"]);
  });

  it("formats hints per platform, global bindings first", () => {
    expect(shortcutLabel("palette.terminals", resolve([], "mac"))).toBe("⇧⌘F");
    expect(shortcutLabel("palette.terminals", resolve([]))).toBe("Ctrl Shift F");
    expect(shortcutLabel("sidebar.toggle", resolve([], "mac"))).toBe("⌘B");
    expect(shortcutLabel("sidebar.toggle", resolve([]))).toBe("Ctrl B");
    expect(shortcutLabel("terminal.zoomIn", resolve([]))).toBe("Ctrl =");
    expect(shortcutLabel("tmux.newWindow", resolve([]))).toBeUndefined();
  });
});

describe("resolveKeymap", () => {
  it("removes a default with a leading minus", () => {
    const keymap = resolve([{ key: "ctrl+b", command: "-sidebar.toggle" }]);
    expect(on(keymap, "ctrl+b")).toEqual([]);
    expect(keymap.bindingsFor("sidebar.toggle")).toEqual([]);
    // Mac has no Ctrl+B default, so the same entry leaves Cmd+B alone.
    const mac = resolve([{ key: "ctrl+b", command: "-sidebar.toggle" }], "mac");
    expect(on(mac, "ctrl+b")).toEqual([]);
    expect(on(mac, "cmd+b")).toEqual(["sidebar.toggle"]);
  });

  it("limits a default to its platform, never a user entry", () => {
    const defaults = [{ key: "ctrl+j", command: "palette.files", platform: "other" as const }];
    expect(on(resolveKeymap(defaults, [], "other"), "ctrl+j")).toEqual(["palette.files"]);
    expect(on(resolveKeymap(defaults, [], "mac"), "ctrl+j")).toEqual([]);
    // A user who wants Ctrl+B on Mac writes it with `key`.
    const mac = resolve([{ key: "ctrl+b", command: "sidebar.toggle", scope: "app" }], "mac");
    expect(on(mac, "ctrl+b")).toEqual(["sidebar.toggle"]);
  });

  it("removes only the named command on that chord", () => {
    const keymap = resolve([{ key: "ctrl+k", command: "-sidebar.toggle" }]);
    expect(on(keymap, "ctrl+k")).toEqual(["palette.commands"]);
    expect(on(keymap, "ctrl+b")).toEqual(["sidebar.toggle"]);
  });

  it("removes earlier user entries too, and later ones come back", () => {
    const keymap = resolve([
      { key: "ctrl+j", command: "palette.files" },
      { key: "ctrl+j", command: "-palette.files" },
      { key: "ctrl+shift+b", command: "sidebar.toggle" },
    ]);
    expect(on(keymap, "ctrl+j")).toEqual([]);
    expect(on(keymap, "ctrl+shift+b")).toEqual(["sidebar.toggle"]);
  });

  it("lets later entries win and lists the conflict", () => {
    const keymap = resolve([{ key: "ctrl+k", command: "sidebar.toggle" }]);
    expect(on(keymap, "ctrl+k")).toEqual(["sidebar.toggle", "palette.commands"]);
    expect(keymap.conflicts).toHaveLength(1);
    expect(keymap.conflicts[0]?.chordKey).toBe("ctrl+k");
    // The hidden default no longer counts as a hint.
    expect(keymap.bindingsFor("palette.commands")).toEqual([]);
    expect(keymap.bindingsFor("sidebar.toggle").map((binding) => binding.chordKey)).toEqual([
      "ctrl+b",
      "ctrl+k",
    ]);
  });

  it("does not report scopes that never overlap", () => {
    const keymap = resolve([{ key: "ctrl+b", command: "terminal.prefix", scope: "terminal" }]);
    expect(on(keymap, "ctrl+b")).toEqual(["terminal.prefix", "sidebar.toggle"]);
    expect(keymap.conflicts).toEqual([]);
    expect(keymap.bindingsFor("sidebar.toggle")).toHaveLength(1);
  });

  it("keeps args of any JSON type", () => {
    const keymap = resolve([
      { key: "ctrl+j", command: "views.close", args: null },
      { key: "ctrl+shift+j", command: "terminal.prefix", args: [1, "two", true] },
    ]);
    expect(keymap.lookup.get(key("ctrl+j"))?.[0]).toHaveProperty("args", null);
    expect(keymap.lookup.get(key("ctrl+shift+j"))?.[0]?.args).toEqual([1, "two", true]);
  });

  it("uses mac entries on Mac only and keeps args", () => {
    const entry: KeybindingEntry = {
      mac: "cmd+j",
      command: "palette.open",
      args: { mode: "terminals" },
      scope: "app",
    };
    expect(on(resolve([entry]), "cmd+j")).toEqual([]);
    const mac = resolve([entry], "mac");
    const binding = mac.lookup.get(key("cmd+j", "mac"))?.[0];
    expect(binding).toMatchObject({
      command: "palette.open",
      args: { mode: "terminals" },
      scope: "app",
      source: "user",
      index: 0,
    });
  });

  it("prefers mac over key on Mac", () => {
    const entry: KeybindingEntry = { key: "ctrl+j", mac: "cmd+j", command: "palette.files" };
    expect(on(resolve([entry]), "ctrl+j")).toEqual(["palette.files"]);
    expect(on(resolve([entry], "mac"), "cmd+j")).toEqual(["palette.files"]);
    expect(on(resolve([entry], "mac"), "ctrl+j")).toEqual([]);
  });

  it("resolves mod per platform", () => {
    const entry: KeybindingEntry = { key: "mod+j", command: "palette.files" };
    expect(on(resolve([entry]), "ctrl+j")).toEqual(["palette.files"]);
    expect(on(resolve([entry], "mac"), "cmd+j")).toEqual(["palette.files"]);
    expect(shortcutLabel("palette.files", resolve([entry], "mac"))).toBe("⌘P");
  });

  it("reports unknown commands and bad chords without breaking the rest", () => {
    const keymap = resolve([
      { key: "ctrl+j", command: "nope.thing" },
      { key: "ctrl+shift", command: "palette.files" },
      { key: "ctrl+l", command: "-also.unknown" },
      { key: "ctrl+shift+j", command: "palette.files" },
    ]);
    expect(keymap.unknownCommands).toEqual(["nope.thing", "also.unknown"]);
    expect(keymap.issues.map((issue) => issue.index)).toEqual([0, 1, 2]);
    expect(keymap.issues.every((issue) => issue.source === "user")).toBe(true);
    expect(on(keymap, "ctrl+j")).toEqual([]);
    expect(on(keymap, "ctrl+shift+j")).toEqual(["palette.files"]);
    expect(on(keymap, "ctrl+k")).toEqual(["palette.commands"]);
  });

  it("treats the same command twice as no conflict", () => {
    const keymap = resolve([{ key: "ctrl+k", command: "palette.commands" }]);
    expect(keymap.conflicts).toEqual([]);
    expect(keymap.bindingsFor("palette.commands")).toHaveLength(1);
  });
});
