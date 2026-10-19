import { afterEach, describe, expect, it, vi } from "vitest";
import {
  THEME_CACHE_KEY,
  getThemeSetting,
  resetThemeSettingForTests,
  setThemeSetting,
  subscribeThemeSetting,
} from "./theme-setting";

afterEach(() => {
  resetThemeSettingForTests();
  vi.unstubAllGlobals();
});

describe("theme setting", () => {
  it("starts from the pre paint cache", () => {
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => (key === THEME_CACHE_KEY ? "light" : null),
    });
    expect(getThemeSetting()).toBe("light");
  });

  it("falls back to dark for a missing, unknown or unreadable cache", () => {
    expect(getThemeSetting()).toBe("dark");
    resetThemeSettingForTests();
    vi.stubGlobal("localStorage", { getItem: () => "blue" });
    expect(getThemeSetting()).toBe("dark");
    resetThemeSettingForTests();
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
    });
    expect(getThemeSetting()).toBe("dark");
  });

  it("tells listeners who changed it, once per change", () => {
    const listener = vi.fn();
    const stop = subscribeThemeSetting(listener);
    setThemeSetting("system");
    setThemeSetting("system");
    setThemeSetting("light", "sync");
    stop();
    setThemeSetting("dark");
    expect(listener.mock.calls).toEqual([["user"], ["sync"]]);
    expect(getThemeSetting()).toBe("dark");
  });
});
