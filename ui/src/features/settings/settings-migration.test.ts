import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LEGACY_MIGRATED_KEY,
  LEGACY_SETTINGS_KEY,
  LEGACY_TERMINAL_KEY,
  finishLegacyMigration,
  migrateLegacyDeviceSettings,
  migrateLegacySettings,
} from "./settings-migration";
import {
  readDeviceSettings,
  resetDeviceSettingsForTests,
  writeDeviceSetting,
} from "./device-settings";
import { defaultToolbarKeys } from "./settings-store";
import { resolveSettings } from "./settings-schema";

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

let storage: Storage;

const persisted = (state: Record<string, unknown>, version: number) =>
  JSON.stringify({ state, version });

beforeEach(() => {
  storage = memoryStorage();
  vi.stubGlobal("localStorage", storage);
  resetDeviceSettingsForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetDeviceSettingsForTests();
});

describe("migrateLegacySettings", () => {
  it("returns null for a browser with nothing stored", () => {
    expect(migrateLegacySettings()).toBeNull();
    expect(readDeviceSettings()).toEqual({});
  });

  it("returns null when every stored value is a default", () => {
    storage.setItem("theme", "dark");
    storage.setItem(
      LEGACY_TERMINAL_KEY,
      persisted({ themeName: "tmuxde", cursorBlink: true, scrollback: 5000 }, 3),
    );
    storage.setItem(
      LEGACY_SETTINGS_KEY,
      persisted({ toolbarKeys: defaultToolbarKeys, wrapLines: false }, 2),
    );
    expect(migrateLegacySettings()).toBeNull();
  });

  it("builds overrides for user keys from both blobs and the theme", () => {
    storage.setItem("theme", "light");
    storage.setItem(
      LEGACY_TERMINAL_KEY,
      persisted(
        {
          themeName: "nord",
          cursorStyle: "bar",
          scrollback: 20000,
          codeWeight: 500,
          terminalWeight: 700,
          fontFamily: '"Fira Code", monospace',
        },
        3,
      ),
    );
    storage.setItem(
      LEGACY_SETTINGS_KEY,
      persisted(
        {
          wrapLines: true,
          commitFilterPatterns: "*.lock",
          commitFilterMode: "only",
          gestures: { pinchToZoom: false, twoFingerScroll: false },
          toolbarKeys: [
            { id: "esc", visible: false },
            { id: "at", visible: true },
          ],
        },
        2,
      ),
    );
    const overrides = migrateLegacySettings();
    expect(overrides).toEqual({
      "appearance.theme": "light",
      "terminal.theme": "nord",
      "terminal.fontFamily": '"Fira Code", monospace',
      "terminal.fontWeight": 700,
      "terminal.cursorStyle": "bar",
      "terminal.scrollback": 20000,
      "editor.fontWeight": 500,
      "files.wrapLines": true,
      "changes.filterPatterns": "*.lock",
      "changes.filterMode": "only",
      "touch.gesture.pinchToZoom": false,
      "touch.toolbarKeys": defaultToolbarKeys
        .filter((key) => (key.id === "esc" ? false : key.visible || key.id === "at"))
        .map((key) => key.id),
    });
    expect(resolveSettings(overrides)["touch.toolbarKeys"]).toContain("at");
  });

  it("runs the old terminal store upgrades", () => {
    storage.setItem(
      LEGACY_TERMINAL_KEY,
      persisted({ themeName: "dracula", gpuRendering: true, codeWeight: 500 }, 0),
    );
    const overrides = migrateLegacySettings();
    // Dracula was the old default, GPU on was never a choice, and the
    // terminal weight starts at the code weight.
    expect(overrides).toEqual({ "terminal.fontWeight": 500, "editor.fontWeight": 500 });
    expect(readDeviceSettings()).toEqual({});
  });

  it("does not carry a retired default font", () => {
    storage.setItem(
      LEGACY_TERMINAL_KEY,
      persisted({ fontFamily: '"IBM Plex Mono", monospace' }, 3),
    );
    expect(migrateLegacySettings()).toBeNull();
  });

  it("drops values of the wrong shape", () => {
    storage.setItem(
      LEGACY_TERMINAL_KEY,
      persisted({ scrollback: "lots", cursorStyle: "beam", terminalWeight: 650 }, 3),
    );
    storage.setItem(LEGACY_SETTINGS_KEY, "{not json");
    expect(migrateLegacySettings()).toBeNull();
  });

  it("writes device scope values to this browser only", () => {
    storage.setItem(
      LEGACY_TERMINAL_KEY,
      persisted({ fontSize: 19, codeZoom: 1.4, gpuRendering: true, cursorBlink: false }, 3),
    );
    expect(migrateLegacySettings()).toEqual({ "terminal.cursorBlink": false });
    expect(readDeviceSettings()).toEqual({
      "terminal.fontSize": 19,
      "editor.zoom": 1.4,
      "terminal.gpuRendering": true,
    });
  });

  it("keeps a device value set since the legacy blob", () => {
    writeDeviceSetting("terminal.fontSize", 12);
    storage.setItem(LEGACY_TERMINAL_KEY, persisted({ fontSize: 19 }, 3));
    migrateLegacySettings();
    expect(readDeviceSettings()).toEqual({ "terminal.fontSize": 12 });
  });

  it("moves only device values when the server document is already set", () => {
    storage.setItem(LEGACY_TERMINAL_KEY, persisted({ codeZoom: 1.5, cursorBlink: false }, 3));
    migrateLegacyDeviceSettings();
    expect(readDeviceSettings()).toEqual({ "editor.zoom": 1.5 });
  });
});

describe("finishLegacyMigration", () => {
  it("removes the two store blobs and keeps the theme cache", () => {
    storage.setItem("theme", "light");
    storage.setItem(LEGACY_SETTINGS_KEY, "{}");
    storage.setItem(LEGACY_TERMINAL_KEY, "{}");
    finishLegacyMigration();
    expect(storage.getItem(LEGACY_SETTINGS_KEY)).toBeNull();
    expect(storage.getItem(LEGACY_TERMINAL_KEY)).toBeNull();
    expect(storage.getItem("theme")).toBe("light");
    expect(storage.getItem(LEGACY_MIGRATED_KEY)).toBe("1");
  });

  it("stops reading the theme cache as an old choice", () => {
    storage.setItem("theme", "light");
    expect(migrateLegacySettings()).toEqual({ "appearance.theme": "light" });
    finishLegacyMigration();
    // A later first sync, after a disconnect, finds only the cache.
    expect(migrateLegacySettings()).toBeNull();
  });

  it("still moves store blobs after the flag, without the cached theme", () => {
    finishLegacyMigration();
    storage.setItem("theme", "light");
    storage.setItem(LEGACY_SETTINGS_KEY, persisted({ wrapLines: true }, 0));
    expect(migrateLegacySettings()).toEqual({ "files.wrapLines": true });
  });
});
