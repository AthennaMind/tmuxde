import { describe, it, expect, vi } from "vitest";
import { mergeToolbarKeys, defaultToolbarKeys } from "./settings-store";

/**
 * Stored visibility meets the current defaults here, for legacy rows and for
 * the visible ids of the settings document. A key added to the defaults must
 * reach people who saved their row before it existed.
 */
describe("mergeToolbarKeys", () => {
  const legacy = [
    { id: "tab", label: "Tab", key: "\t", visible: true },
    { id: "esc", label: "Esc", key: "\x1b", visible: false },
    { id: "pipe", label: "|", key: "|", visible: true },
  ];

  it("adds Shift+Tab to a row saved before it existed", () => {
    const merged = mergeToolbarKeys(legacy);
    const shiftTab = merged.find((k) => k.id === "shift-tab");
    expect(shiftTab?.key).toBe("\x1b[Z");
    expect(shiftTab?.visible).toBe(true);
  });

  it("keeps the visibility the user chose", () => {
    const merged = mergeToolbarKeys(legacy);
    expect(merged.find((k) => k.id === "esc")?.visible).toBe(false);
    expect(merged.find((k) => k.id === "tab")?.visible).toBe(true);
  });

  it("takes the sequence from the default, never from the stored copy", () => {
    // So a wrong control code is fixable in a release rather than by asking
    // people to clear their site data.
    const merged = mergeToolbarKeys([{ id: "tab", label: "Tab", key: "wrong", visible: true }]);
    expect(merged.find((k) => k.id === "tab")?.key).toBe("\t");
  });

  it("drops ids that are no longer defaults", () => {
    const merged = mergeToolbarKeys([
      ...legacy,
      { id: "removed-long-ago", label: "?", key: "?", visible: true },
    ]);
    expect(merged.some((k) => k.id === "removed-long-ago")).toBe(false);
  });

  it("returns the full default set for a browser with nothing stored", () => {
    expect(mergeToolbarKeys(undefined)).toEqual(defaultToolbarKeys);
  });

  it("gives every key a group, so the sheet can never orphan one", () => {
    for (const key of mergeToolbarKeys(legacy)) {
      expect(key.group).toBeTruthy();
    }
  });
});

describe("settings store", () => {
  it("defaults to no commit filter patterns in hide mode", async () => {
    const { useSettingsStore } = await import("./settings-store");
    expect(useSettingsStore.getState().commitFilterPatterns).toBe("");
    expect(useSettingsStore.getState().commitFilterMode).toBe("hide");
  });

  it("toggles one toolbar key and keeps the rest", async () => {
    const { useSettingsStore } = await import("./settings-store");
    const before = useSettingsStore.getState().toolbarKeys;
    useSettingsStore.getState().toggleToolbarKey("at");
    const after = useSettingsStore.getState().toolbarKeys;
    expect(after.find((k) => k.id === "at")?.visible).toBe(true);
    expect(after.filter((k) => k.id !== "at")).toEqual(before.filter((k) => k.id !== "at"));
    useSettingsStore.getState().resetToolbarKeys();
    expect(useSettingsStore.getState().toolbarKeys).toBe(defaultToolbarKeys);
  });

  it("no longer writes the legacy localStorage blob", async () => {
    const setItem = vi.fn();
    vi.stubGlobal("localStorage", { getItem: () => null, setItem, removeItem: vi.fn() });
    vi.resetModules();
    const { useSettingsStore } = await import("./settings-store");
    useSettingsStore.getState().setWrapLines(true);
    expect(setItem).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
