import { afterEach, describe, it, expect, vi } from "vitest";
import {
  mergeCommitFilter,
  mergeGestures,
  mergeToolbarKeys,
  defaultToolbarKeys,
  type GestureSettings,
} from "./settings-store";

/**
 * The migration is the whole feature for anyone who has opened the app before.
 *
 * `persist` writes `toolbarKeys` to localStorage on first run and hands that
 * frozen array back forever, so a key added to the defaults would otherwise
 * reach new installs only — and `Shift+Tab` is being added for people who
 * already use this every day.
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
    const merged = mergeToolbarKeys([
      { id: "tab", label: "Tab", key: "wrong", visible: true },
    ]);
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

/**
 * The same migration problem, one level down.
 *
 * The obvious spread — `{ ...current, ...stored }` — copies whatever is in
 * localStorage back out, including keys that no longer exist. That matters
 * here because two gesture toggles were removed after shipping (they were
 * switches wired to nothing), and a plain spread would have carried them in
 * every persisted blob forever. It also has to survive a stored value of
 * `false`, which is the whole point of a toggle someone turned off.
 */
describe("mergeGestures", () => {
  const current: GestureSettings = {
    swipeToSwitchSessions: true,
    swipeToSwitchPanes: true,
    dragToScroll: true,
    pinchToZoom: true,
    longPressPaneMenu: true,
  };

  it("keeps a toggle the user turned off", () => {
    expect(mergeGestures({ pinchToZoom: false }, current)).toEqual({
      ...current,
      pinchToZoom: false,
    });
  });

  it("drops keys that no longer exist", () => {
    const stored = {
      pinchToZoom: false,
      // Both removed after shipping; a spread would keep resurrecting them.
      doubleTapToCopy: true,
      longPressContextMenu: true,
      twoFingerScroll: false,
    } as Partial<GestureSettings>;
    const merged = mergeGestures(stored, current);
    expect(Object.keys(merged).sort()).toEqual(Object.keys(current).sort());
  });

  it("gives a new toggle its default on an install that predates it", () => {
    // `dragToScroll` replaced the never-implemented `twoFingerScroll`.
    const merged = mergeGestures(
      { twoFingerScroll: false } as Partial<GestureSettings>,
      current,
    );
    expect(merged.dragToScroll).toBe(true);
  });

  it("ignores a non-boolean left behind by a hand-edit", () => {
    const merged = mergeGestures(
      { pinchToZoom: "yes" } as unknown as Partial<GestureSettings>,
      current,
    );
    expect(merged.pinchToZoom).toBe(true);
  });

  it("returns the defaults when nothing was stored", () => {
    expect(mergeGestures(undefined, current)).toEqual(current);
  });

  it("does not mutate the defaults it was handed", () => {
    const snapshot = { ...current };
    mergeGestures({ dragToScroll: false }, current);
    expect(current).toEqual(snapshot);
  });
});

describe("mergeCommitFilter", () => {
  const current = { commitFilterPatterns: "", commitFilterMode: "hide" as const };

  it("keeps a stored filter", () => {
    expect(
      mergeCommitFilter(
        { commitFilterPatterns: "md, docs/**", commitFilterMode: "only" },
        current,
      ),
    ).toEqual({ commitFilterPatterns: "md, docs/**", commitFilterMode: "only" });
  });

  it("gives the defaults to a blob from before the filter", () => {
    expect(mergeCommitFilter({}, current)).toEqual(current);
    expect(mergeCommitFilter(undefined, current)).toEqual(current);
  });

  it("ignores a mode or text of the wrong shape", () => {
    expect(
      mergeCommitFilter(
        {
          commitFilterPatterns: 3,
          commitFilterMode: "show",
        } as unknown as Parameters<typeof mergeCommitFilter>[0],
        current,
      ),
    ).toEqual(current);
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

/**
 * A fresh store module over the given storage, hydrated on import. `persist`
 * reads `window.localStorage`, so both globals get the stub.
 */
async function loadStore(storage: Storage) {
  vi.stubGlobal("localStorage", storage);
  vi.stubGlobal("window", { localStorage: storage });
  vi.resetModules();
  return (await import("./settings-store")).useSettingsStore;
}

describe("commit filter settings", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("defaults to no patterns in hide mode", async () => {
    const store = await loadStore(memoryStorage());
    expect(store.getState().commitFilterPatterns).toBe("");
    expect(store.getState().commitFilterMode).toBe("hide");
  });

  it("persists patterns and mode", async () => {
    const storage = memoryStorage();
    const store = await loadStore(storage);
    store.getState().setCommitFilterPatterns("md, *.sh");
    store.getState().setCommitFilterMode("only");
    const saved = JSON.parse(storage.getItem("ccremote-settings") ?? "{}");
    expect(saved.state.commitFilterPatterns).toBe("md, *.sh");
    expect(saved.state.commitFilterMode).toBe("only");

    // Next page load reads them back.
    const reloaded = await loadStore(storage);
    expect(reloaded.getState().commitFilterPatterns).toBe("md, *.sh");
    expect(reloaded.getState().commitFilterMode).toBe("only");
  });

  it("keeps other settings when a stored blob predates the filter", async () => {
    const storage = memoryStorage();
    storage.setItem(
      "ccremote-settings",
      JSON.stringify({ state: { wrapLines: true }, version: 2 }),
    );
    const store = await loadStore(storage);
    expect(store.getState().wrapLines).toBe(true);
    expect(store.getState().commitFilterPatterns).toBe("");
    expect(store.getState().commitFilterMode).toBe("hide");
  });
});
