import { describe, expect, it } from "vitest";
import { DEFAULT_KEYBINDINGS } from "./default-keybindings";
import { resolveKeymap, type KeybindingEntry } from "./keymap";
import { shortcutTitle } from "./shortcut-label";

const resolve = (user: KeybindingEntry[], platform: "mac" | "other" = "other") =>
  resolveKeymap(DEFAULT_KEYBINDINGS, user, platform);

describe("shortcutTitle", () => {
  it("adds the default hint", () => {
    expect(shortcutTitle("Hide sidebar", "sidebar.toggle", resolve([]))).toBe(
      "Hide sidebar (Ctrl B)",
    );
    expect(shortcutTitle("Overview", "overview.toggle", resolve([], "mac"))).toBe("Overview (⌘O)");
  });

  it("follows a rebind from the keybindings document", () => {
    const keymap = resolve([
      { key: "ctrl+b", command: "-sidebar.toggle" },
      { key: "ctrl+shift+b", command: "sidebar.toggle", scope: "app" },
    ]);
    expect(shortcutTitle("Hide sidebar", "sidebar.toggle", keymap)).toBe(
      "Hide sidebar (Ctrl Shift B)",
    );
  });

  it("is only the label when the command has no binding", () => {
    const keymap = resolve([{ key: "ctrl+o", command: "-overview.toggle" }]);
    expect(shortcutTitle("Overview", "overview.toggle", keymap)).toBe("Overview");
  });
});
