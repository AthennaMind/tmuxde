import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { useTerminalStore } from "@/features/terminal/terminal-store";
import {
  applySettings,
  settingsFromStores,
  startSettingsBridge,
  stopSettingsBridge,
} from "./settings-bridge";
import { defaultToolbarKeys, useSettingsStore } from "./settings-store";
import { resolveSettings, type SettingsPatch } from "./settings-schema";
import { readDeviceSettings, resetDeviceSettingsForTests } from "./device-settings";
import { getThemeSetting, resetThemeSettingForTests, setThemeSetting } from "./theme-setting";
import { resetUserDocumentsForTests, useUserDocumentsStore } from "./user-documents-store";

vi.mock("@/features/connection/user-documents-api", () => ({
  getUserDocument: vi.fn(),
  putUserDocument: vi.fn(),
}));

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k: string) => map.get(k) ?? null,
    key: (i: number) => Array.from(map.keys())[i] ?? null,
    removeItem: (k: string) => void map.delete(k),
    setItem: (k: string, v: string) => void map.set(k, v),
  };
}

const terminalDefaults = useTerminalStore.getState();
const settingsDefaults = useSettingsStore.getState();
let updateSettings: Mock<(patch: SettingsPatch) => void>;

beforeEach(() => {
  vi.stubGlobal("localStorage", memoryStorage());
  resetDeviceSettingsForTests();
  resetThemeSettingForTests();
  resetUserDocumentsForTests();
  useTerminalStore.setState(terminalDefaults, true);
  useSettingsStore.setState(settingsDefaults, true);
  updateSettings = vi.fn();
  useUserDocumentsStore.setState({ updateSettings });
  startSettingsBridge();
});

afterEach(() => {
  stopSettingsBridge();
  resetUserDocumentsForTests();
  vi.unstubAllGlobals();
});

describe("settings bridge", () => {
  it("applies a document into the stores and the theme", () => {
    applySettings(
      resolveSettings({
        "appearance.theme": "light",
        "terminal.cursorStyle": "bar",
        "editor.fontWeight": 400,
        "touch.gesture.pinchToZoom": false,
        "touch.toolbarKeys": ["tab", "at"],
      }),
    );
    expect(getThemeSetting()).toBe("light");
    expect(useTerminalStore.getState().cursorStyle).toBe("bar");
    expect(useTerminalStore.getState().codeWeight).toBe(400);
    expect(useSettingsStore.getState().gestures.pinchToZoom).toBe(false);
    const visible = useSettingsStore.getState().toolbarKeys.filter((key) => key.visible);
    expect(visible.map((key) => key.id)).toEqual(["tab", "at"]);
    // Sequences still come from the defaults.
    expect(useSettingsStore.getState().toolbarKeys.map((key) => key.key)).toEqual(
      defaultToolbarKeys.map((key) => key.key),
    );
  });

  it("never writes back while applying", () => {
    applySettings(
      resolveSettings({
        "appearance.theme": "system",
        "terminal.scrollback": 9000,
        "files.wrapLines": true,
      }),
    );
    applySettings(resolveSettings({}));
    expect(updateSettings).not.toHaveBeenCalled();
    expect(readDeviceSettings()).toEqual({});
  });

  it("does not render when the applied values already match", () => {
    const listener = vi.fn();
    const stop = useTerminalStore.subscribe(listener);
    applySettings(settingsFromStores());
    stop();
    expect(listener).not.toHaveBeenCalled();
  });

  it("writes one key for one store action", () => {
    applySettings(resolveSettings({ "terminal.scrollback": 9000 }));
    useTerminalStore.getState().setCursorBlink(false);
    expect(updateSettings).toHaveBeenCalledTimes(1);
    expect(updateSettings).toHaveBeenCalledWith({ "terminal.cursorBlink": false });
  });

  it("deletes the key when a value goes back to its default", () => {
    applySettings(resolveSettings({ "files.wrapLines": true }));
    useSettingsStore.getState().setWrapLines(false);
    expect(updateSettings).toHaveBeenCalledWith({ "files.wrapLines": undefined });
  });

  it("skips a store write that matches the last resolved value", () => {
    vi.stubGlobal("window", { innerWidth: 200 });
    applySettings(resolveSettings({}, { "terminal.fontSize": 22 }));
    expect(useTerminalStore.getState().fontSize).toBe(16);
    // The window grows and the user zooms back to the value this device holds.
    vi.stubGlobal("window", { innerWidth: 2000 });
    useTerminalStore.getState().setFontSize(22);
    expect(useTerminalStore.getState().fontSize).toBe(22);
    expect(readDeviceSettings()).toEqual({});
    useTerminalStore.getState().setFontSize(20);
    expect(readDeviceSettings()).toEqual({ "terminal.fontSize": 20 });
  });

  it("writes gestures and toolbar keys as their own keys", () => {
    useSettingsStore.getState().setGesture("dragToScroll", false);
    expect(updateSettings).toHaveBeenLastCalledWith({ "touch.gesture.dragToScroll": false });
    useSettingsStore.getState().toggleToolbarKey("at");
    const [patch] = updateSettings.mock.calls.at(-1)!;
    expect(Object.keys(patch)).toEqual(["touch.toolbarKeys"]);
    expect(patch["touch.toolbarKeys"]).toContain("at");
  });

  it("routes device keys to this browser, not the document", () => {
    useTerminalStore.getState().setCodeZoom(1.3);
    useTerminalStore.getState().setGpuRendering(true);
    expect(updateSettings).not.toHaveBeenCalled();
    expect(readDeviceSettings()).toEqual({ "editor.zoom": 1.3, "terminal.gpuRendering": true });
  });

  it("does not write a font size clamped during apply", () => {
    vi.stubGlobal("window", { innerWidth: 200 });
    applySettings(resolveSettings({}, { "terminal.fontSize": 24 }));
    // 200px wide caps the font at 16.
    expect(useTerminalStore.getState().fontSize).toBe(16);
    useTerminalStore.getState().setCursorBlink(false);
    expect(readDeviceSettings()).toEqual({});
    expect(updateSettings).toHaveBeenCalledWith({ "terminal.cursorBlink": false });
  });

  it("writes a theme picked in this tab", () => {
    setThemeSetting("light");
    expect(updateSettings).toHaveBeenCalledWith({ "appearance.theme": "light" });
    setThemeSetting("dark");
    expect(updateSettings).toHaveBeenLastCalledWith({ "appearance.theme": undefined });
  });

  it("adopts a theme synced from another tab without writing", () => {
    setThemeSetting("light", "sync");
    expect(updateSettings).not.toHaveBeenCalled();
    // Picking it again here is no change.
    setThemeSetting("dark", "sync");
    setThemeSetting("dark");
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it("applies documents the store delivers to its sink", () => {
    useUserDocumentsStore.setState((state) => ({
      documents: {
        ...state.documents,
        settings: { ...state.documents.settings, text: '{"panes.autoZoom": false}', etag: '"a"' },
      },
    }));
    stopSettingsBridge();
    startSettingsBridge();
    expect(useSettingsStore.getState().autoZoom).toBe(false);
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it("applies this device's values on start, before any document", () => {
    stopSettingsBridge();
    localStorage.setItem(
      "tmuxde-device-settings",
      JSON.stringify({ "editor.zoom": 1.5, "terminal.gpuRendering": true }),
    );
    startSettingsBridge();
    expect(useTerminalStore.getState().codeZoom).toBe(1.5);
    expect(useTerminalStore.getState().gpuRendering).toBe(true);
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it("stops writing after stop", () => {
    stopSettingsBridge();
    useTerminalStore.getState().setCursorBlink(false);
    expect(updateSettings).not.toHaveBeenCalled();
  });
});
