import { beforeEach, describe, expect, it } from "vitest";
import type { WindowInfo } from "@repo/protocol";

import { usePaneStore } from "./pane-store";

function win(overrides: Partial<WindowInfo> = {}): WindowInfo {
  return {
    id: "@1",
    index: 0,
    name: "main",
    active: true,
    paneCount: 2,
    layout: "c195,80x24,0,0",
    ...overrides,
  };
}

describe("setWindows and the zoom belief", () => {
  beforeEach(() => {
    usePaneStore.getState().clearAll();
  });

  /*
   * The bug: a pane unzoomed with `prefix z` on the machine went on being drawn
   * as zoomed in the browser, because nothing the client heard about
   * contradicted it.
   */
  it("clears a stale zoom when the active window says it is not zoomed", () => {
    usePaneStore.getState().setZoomedPane("%3");
    usePaneStore.getState().setWindows([win({ zoomed: false })]);
    expect(usePaneStore.getState().zoomedPaneId).toBeNull();
  });

  it("leaves the belief alone when the window says it is zoomed", () => {
    usePaneStore.getState().setZoomedPane("%3");
    usePaneStore.getState().setWindows([win({ zoomed: true })]);
    expect(usePaneStore.getState().zoomedPaneId).toBe("%3");
  });

  /*
   * `zoomed` is optional in the protocol so that an older relay is read as
   * "cannot say". Treating a missing field as `false` would clear the belief on
   * every window list such a relay sends, which is worse than the bug above:
   * the button would flicker to "Zoom" a second after every zoom.
   */
  it("says nothing about zoom when the relay does not report it", () => {
    usePaneStore.getState().setZoomedPane("%3");
    usePaneStore.getState().setWindows([win()]);
    expect(usePaneStore.getState().zoomedPaneId).toBe("%3");
  });

  it("reads the flag off the active window, not the first one", () => {
    usePaneStore.getState().setZoomedPane("%3");
    usePaneStore
      .getState()
      .setWindows([
        win({ id: "@1", active: false, zoomed: true }),
        win({ id: "@2", active: true, zoomed: false }),
      ]);
    expect(usePaneStore.getState().activeWindowId).toBe("@2");
    expect(usePaneStore.getState().zoomedPaneId).toBeNull();
  });

  it("still lets a pane list have the last word", () => {
    usePaneStore.getState().setWindows([win({ zoomed: false })]);
    usePaneStore.getState().setPanes(
      [
        {
          id: "%1",
          index: 0,
          windowId: "@1",
          active: true,
          zoomed: true,
          dimensions: { cols: 80, rows: 24 },
          position: { x: 0, y: 0 },
        },
      ],
      "@1",
    );
    expect(usePaneStore.getState().zoomedPaneId).toBe("%1");
  });
});
