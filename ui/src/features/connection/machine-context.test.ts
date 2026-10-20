import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearMachineStorage,
  machineBasePath,
  machineId,
  machineStorageKey,
} from "./machine-context";
import { DEVICE_SETTINGS_KEY } from "@/features/settings/device-settings";
import { USER_DOCUMENTS_CACHE_KEY } from "@/features/settings/user-documents-store";

afterEach(() => vi.unstubAllGlobals());

describe("machine context", () => {
  it("keeps existing local sessions and storage compatible", () => {
    vi.stubGlobal("window", { location: { pathname: "/s/dev" } });
    expect(machineId()).toBe("local");
    expect(machineBasePath()).toBe("");
    expect(machineStorageKey("tabs")).toBe("tabs");
  });

  it("separates identical session names and paths by machine", () => {
    vi.stubGlobal("window", { location: { pathname: "/m/alpha/s/dev" } });
    const first = machineStorageKey("tabs");
    expect(machineId()).toBe("alpha");
    expect(machineBasePath()).toBe("/m/alpha");
    vi.stubGlobal("window", { location: { pathname: "/m/beta/s/dev" } });
    expect(machineStorageKey("tabs")).not.toBe(first);
  });
});

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

describe("clearMachineStorage", () => {
  it("removes the user documents cache with workspace data", () => {
    const local = memoryStorage();
    vi.stubGlobal("window", { localStorage: local, sessionStorage: memoryStorage() });
    for (const key of [
      USER_DOCUMENTS_CACHE_KEY,
      DEVICE_SETTINGS_KEY,
      "tmuxde-main-tabs:machine:alpha",
      "theme",
      "tmuxde-sidebar",
    ]) {
      local.setItem(key, "x");
    }
    clearMachineStorage();
    expect(local.getItem(USER_DOCUMENTS_CACHE_KEY)).toBeNull();
    expect(local.getItem("tmuxde-main-tabs:machine:alpha")).toBeNull();
    // Preferences outside the synced settings stay, as before. Device sizes
    // stay too, as the font size did in its old store.
    expect(local.getItem(DEVICE_SETTINGS_KEY)).toBe("x");
    expect(local.getItem("theme")).toBe("x");
    expect(local.getItem("tmuxde-sidebar")).toBe("x");
  });
});
