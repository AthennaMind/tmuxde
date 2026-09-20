import { describe, expect, it } from "vitest";

import { cheatsheetFor } from "./gesture-cheatsheet";
import {
  useSettingsStore,
  type GestureSettings,
} from "@/stores/settings-store";

const allOn = (): GestureSettings => ({
  swipeToSwitchSessions: true,
  swipeToSwitchPanes: true,
  dragToScroll: true,
  pinchToZoom: true,
  longPressPaneMenu: true,
});

function entries(gestures: GestureSettings): string[] {
  return cheatsheetFor(gestures).flatMap((s) =>
    s.entries.map((e) => e.gesture),
  );
}

describe("cheatsheetFor", () => {
  it("teaches the long press when the long press is armed", () => {
    expect(entries(allOn())).toContain("Press and hold");
  });

  it("does not teach a gesture the user has switched off", () => {
    const off = { ...allOn(), longPressPaneMenu: false };
    expect(entries(off)).not.toContain("Press and hold");
    // The rest of the section survives — one switch is not a blackout.
    expect(entries(off)).toContain("Pinch");
  });

  it("drops both halves of drag-to-scroll together", () => {
    const off = { ...allOn(), dragToScroll: false };
    expect(entries(off)).not.toContain("Drag up or down");
    expect(entries(off)).not.toContain("Flick and release");
  });

  it("keeps swipe while either of its two switches is on", () => {
    expect(entries({ ...allOn(), swipeToSwitchPanes: false })).toContain(
      "Swipe left or right",
    );
    expect(
      entries({
        ...allOn(),
        swipeToSwitchPanes: false,
        swipeToSwitchSessions: false,
      }),
    ).not.toContain("Swipe left or right");
  });

  it("never renders a heading over nothing", () => {
    const nothing: GestureSettings = {
      swipeToSwitchSessions: false,
      swipeToSwitchPanes: false,
      dragToScroll: false,
      pinchToZoom: false,
      longPressPaneMenu: false,
    };
    for (const section of cheatsheetFor(nothing)) {
      expect(section.entries.length).toBeGreaterThan(0);
    }
  });

  /*
   * The rot this file exists to prevent.
   *
   * A cheat sheet keyed on a setting that no longer exists would silently
   * always render — `gestures[key]` is `undefined`, which is falsy, so it
   * would silently never render instead. Either way nobody notices until a
   * user does. Held against the live store rather than a copy of the type, so
   * a renamed switch fails here and not in review.
   */
  it("names only settings the store actually has", () => {
    const live = useSettingsStore.getState().gestures;
    for (const section of cheatsheetFor(allOn())) {
      for (const entry of section.entries) {
        if (!entry.setting) continue;
        expect(Object.keys(live)).toContain(entry.setting);
      }
    }
  });
});
