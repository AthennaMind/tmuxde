import { describe, it, expect } from "vitest";
import {
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
