import { describe, it, expect, beforeEach, vi } from "vitest";

const sent: { type: string; id?: string; zoomed?: boolean }[] = [];
let status = "connected";

vi.mock("@/hooks/use-websocket", () => ({
  getRelayClient: () => ({
    get status() {
      return status;
    },
    send: (message: never) => sent.push(message),
  }),
}));

import { zoomPane } from "./pane-zoom";
import { usePaneStore } from "@/stores/pane-store";

beforeEach(() => {
  sent.length = 0;
  status = "connected";
  usePaneStore.setState({ activePaneId: "%1", zoomedPaneId: null });
});

describe("zoomPane", () => {
  it("always names a pane and a state, never a bare toggle", () => {
    // The whole point. A message with neither is a toggle at the far end, and
    // two of them cancel out.
    zoomPane();
    expect(sent).toEqual([{ type: "pane:zoom", id: "%1", zoomed: true }]);
  });

  it("makes a second tap mean what it looks like, not the opposite", () => {
    // The reported bug, from the other end. Two bare toggles inside one round
    // trip cancel out while the button still reads "Zoom", so the user sees
    // nothing happen. Here each tap states a wish against a button that has
    // already moved, so two taps are zoom-then-unzoom — which is what tapping
    // a zoom button twice looks like it should do.
    zoomPane();
    zoomPane();
    expect(sent.map((m) => m.zoomed)).toEqual([true, false]);
  });

  it("ignores a late announcement's worth of lag, because state is absolute", () => {
    // Even if the relay is slow and re-announces the old layout in between,
    // the request that arrives says "zoomed: true" rather than "change it",
    // so a duplicate delivery cannot flip it back.
    zoomPane({ id: "%1", zoomed: true });
    zoomPane({ id: "%1", zoomed: true });
    expect(sent.map((m) => m.zoomed)).toEqual([true, true]);
  });

  it("unzooms the pane that is zoomed", () => {
    usePaneStore.setState({ zoomedPaneId: "%1" });
    zoomPane();
    expect(sent).toEqual([{ type: "pane:zoom", id: "%1", zoomed: false }]);
  });

  it("moves the zoom rather than dropping it when another pane holds it", () => {
    // Asked about *this* pane, not about the window: tapping B while A is
    // zoomed means "zoom B", and a window-level toggle could only unzoom A.
    usePaneStore.setState({ zoomedPaneId: "%2" });
    zoomPane({ id: "%1" });
    expect(sent).toEqual([{ type: "pane:zoom", id: "%1", zoomed: true }]);
  });

  it("honours an explicit state over what it can infer", () => {
    usePaneStore.setState({ zoomedPaneId: "%1" });
    zoomPane({ id: "%1", zoomed: true });
    expect(sent).toEqual([{ type: "pane:zoom", id: "%1", zoomed: true }]);
  });

  it("answers the tap locally so the button does not wait for the relay", () => {
    zoomPane();
    expect(usePaneStore.getState().zoomedPaneId).toBe("%1");
    zoomPane();
    expect(usePaneStore.getState().zoomedPaneId).toBeNull();
  });

  it("stays quiet while disconnected rather than lying about the state", () => {
    status = "disconnected";
    zoomPane();
    expect(sent).toEqual([]);
    expect(usePaneStore.getState().zoomedPaneId).toBeNull();
  });
});
