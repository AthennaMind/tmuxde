import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEVICE_SETTINGS_KEY,
  clearDeviceSettings,
  readDeviceSettings,
  resetDeviceSettingsForTests,
  writeDeviceSetting,
} from "./device-settings";

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

beforeEach(() => {
  resetDeviceSettingsForTests();
  storage = memoryStorage();
  vi.stubGlobal("localStorage", storage);
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetDeviceSettingsForTests();
});

describe("device settings", () => {
  it("is empty on a fresh browser", () => {
    expect(readDeviceSettings()).toEqual({});
  });

  it("writes and reads values under one key", () => {
    writeDeviceSetting("terminal.fontSize", 16);
    writeDeviceSetting("editor.zoom", 1.2);
    expect(readDeviceSettings()).toEqual({ "terminal.fontSize": 16, "editor.zoom": 1.2 });
    expect(JSON.parse(storage.getItem(DEVICE_SETTINGS_KEY)!)).toEqual({
      "terminal.fontSize": 16,
      "editor.zoom": 1.2,
    });
  });

  it("removes a value written as undefined, and the key with the last one", () => {
    writeDeviceSetting("terminal.gpuRendering", true);
    writeDeviceSetting("terminal.gpuRendering", undefined);
    expect(readDeviceSettings()).toEqual({});
    expect(storage.getItem(DEVICE_SETTINGS_KEY)).toBeNull();
  });

  it("ignores values outside the schema", () => {
    writeDeviceSetting("terminal.fontSize", 99);
    expect(readDeviceSettings()).toEqual({});
  });

  it("skips hand edits of the wrong type and keys that are not device scope", () => {
    storage.setItem(
      DEVICE_SETTINGS_KEY,
      JSON.stringify({
        "terminal.fontSize": "big",
        "terminal.gpuRendering": true,
        "terminal.cursorBlink": false,
      }),
    );
    expect(readDeviceSettings()).toEqual({ "terminal.gpuRendering": true });
  });

  it("reads broken JSON as empty", () => {
    storage.setItem(DEVICE_SETTINGS_KEY, "{");
    expect(readDeviceSettings()).toEqual({});
  });

  it("keeps values in memory when storage throws", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    });
    writeDeviceSetting("terminal.fontSize", 18);
    expect(readDeviceSettings()).toEqual({ "terminal.fontSize": 18 });
  });

  it("works without any storage", () => {
    vi.stubGlobal("localStorage", undefined);
    writeDeviceSetting("editor.zoom", 1.5);
    expect(readDeviceSettings()).toEqual({ "editor.zoom": 1.5 });
  });

  it("clears every value", () => {
    writeDeviceSetting("terminal.fontSize", 16);
    clearDeviceSettings();
    expect(readDeviceSettings()).toEqual({});
    expect(storage.getItem(DEVICE_SETTINGS_KEY)).toBeNull();
  });
});
