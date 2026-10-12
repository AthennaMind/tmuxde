import { describe, it, expect } from "vitest";
import type { PaneInfo, SessionInfo, WindowInfo } from "@repo/protocol";
import {
  resolveStep,
  resolveStrip,
  stepTarget,
  type StripInput,
} from "./switch-strip";

/**
 * The precedence table, exhaustively.
 *
 * This module exists because the dots and the swipe used to compute their
 * targets independently and disagreed. Every case here is a shape the old
 * split produced a wrong answer for.
 */

function win(id: string, index: number, active = false): WindowInfo {
  return {
    id,
    index,
    name: `w${index}`,
    active,
    paneCount: 1,
    layout: "",
  };
}

function pane(
  id: string,
  index: number,
  windowId: string,
  active = false,
  zoomed = false,
): PaneInfo {
  return {
    id,
    index,
    windowId,
    active,
    zoomed,
    dimensions: { cols: 80, rows: 24 },
    position: { x: 0, y: 0 },
  };
}

function sess(name: string): SessionInfo {
  return {
    name,
    id: `$${name}`,
    windows: 1,
    attached: false,
    created: "",
    activity: "",
  };
}

const BOTH_ON = { swipeToSwitchSessions: true, swipeToSwitchPanes: true };

function input(over: Partial<StripInput> = {}): StripInput {
  return {
    windows: [],
    panes: [],
    activeWindowId: null,
    activePaneId: null,
    zoomedPaneId: null,
    sessions: [],
    activeSessionId: null,
    gestures: BOTH_ON,
    ...over,
  };
}

const threeWindows = {
  windows: [win("@1", 0), win("@2", 1, true), win("@3", 2)],
  activeWindowId: "@2",
  panes: [pane("%2", 0, "@2", true)],
  activePaneId: "%2",
};

describe("resolveStrip — windows first", () => {
  it("shows windows whenever there is more than one", () => {
    const strip = resolveStrip(input(threeWindows));
    expect(strip.kind).toBe("window");
    expect(strip.entries.map((e) => e.key)).toEqual(["@1", "@2", "@3"]);
    expect(strip.activeIndex).toBe(1);
  });

  it("prefers windows even when the current window has several panes", () => {
    const strip = resolveStrip(
      input({
        ...threeWindows,
        panes: [pane("%2", 0, "@2", true), pane("%4", 1, "@2")],
      }),
    );
    expect(strip.kind).toBe("window");
  });

  it("prefers windows even when a pane is zoomed", () => {
    const strip = resolveStrip(
      input({
        ...threeWindows,
        panes: [pane("%2", 0, "@2", true, true), pane("%4", 1, "@2")],
        zoomedPaneId: "%2",
      }),
    );
    expect(strip.kind).toBe("window");
    // But the window carrying the zoom is marked, so the strip can say so.
    expect(strip.entries.find((e) => e.key === "@2")?.zoomed).toBe(true);
    expect(strip.entries.find((e) => e.key === "@1")?.zoomed).toBe(false);
  });

  it("reports activeIndex -1 rather than guessing when nothing matches", () => {
    const strip = resolveStrip(
      input({ ...threeWindows, activeWindowId: "@nope" }),
    );
    expect(strip.activeIndex).toBe(-1);
  });
});

describe("resolveStrip — panes only when zoomed", () => {
  const oneWindowThreePanes = {
    windows: [win("@1", 0, true)],
    activeWindowId: "@1",
    panes: [
      pane("%1", 0, "@1", true),
      pane("%2", 1, "@1"),
      pane("%3", 2, "@1"),
    ],
    activePaneId: "%1",
  };

  it("shows panes when one is zoomed", () => {
    const strip = resolveStrip(
      input({ ...oneWindowThreePanes, zoomedPaneId: "%1" }),
    );
    expect(strip.kind).toBe("pane");
    expect(strip.entries.map((e) => e.key)).toEqual(["%1", "%2", "%3"]);
    expect(strip.activeIndex).toBe(0);
  });

  it("shows nothing when the panes are all visible anyway", () => {
    // Stepping panes in an unzoomed window redraws nothing — tmux has already
    // painted every one of them. Offering it is what made the swipe feel dead.
    const strip = resolveStrip(input(oneWindowThreePanes));
    expect(strip.entries).toEqual([]);
  });

  it("respects swipeToSwitchPanes being off", () => {
    const strip = resolveStrip(
      input({
        ...oneWindowThreePanes,
        zoomedPaneId: "%1",
        gestures: { swipeToSwitchSessions: true, swipeToSwitchPanes: false },
      }),
    );
    expect(strip.entries).toEqual([]);
  });
});

describe("resolveStrip — sessions last", () => {
  const soleWindowSolePane = {
    windows: [win("@1", 0, true)],
    activeWindowId: "@1",
    panes: [pane("%1", 0, "@1", true)],
    activePaneId: "%1",
  };

  it("steps sessions when there is nothing else to step", () => {
    const strip = resolveStrip(
      input({
        ...soleWindowSolePane,
        sessions: [sess("work"), sess("play")],
        activeSessionId: "work",
      }),
    );
    expect(strip.kind).toBe("session");
    expect(strip.entries.map((e) => e.key)).toEqual(["work", "play"]);
    expect(strip.activeIndex).toBe(0);
  });

  it("does not reach sessions while a second window exists", () => {
    // The old code returned early inside the pane branch, so this path was
    // effectively unreachable and swipe-to-switch-session was silently dead.
    const strip = resolveStrip(
      input({
        ...threeWindows,
        sessions: [sess("work"), sess("play")],
        activeSessionId: "work",
      }),
    );
    expect(strip.kind).toBe("window");
  });

  it("respects swipeToSwitchSessions being off", () => {
    const strip = resolveStrip(
      input({
        ...soleWindowSolePane,
        sessions: [sess("work"), sess("play")],
        activeSessionId: "work",
        gestures: { swipeToSwitchSessions: false, swipeToSwitchPanes: true },
      }),
    );
    expect(strip.entries).toEqual([]);
  });

  it("shows nothing for a single session", () => {
    const strip = resolveStrip(
      input({
        ...soleWindowSolePane,
        sessions: [sess("work")],
        activeSessionId: "work",
      }),
    );
    expect(strip.entries).toEqual([]);
  });
});

describe("stepTarget", () => {
  const strip = resolveStrip(input(threeWindows));

  it("wraps forwards", () => {
    expect(stepTarget(strip, 1)?.key).toBe("@3");
    const atEnd = resolveStrip(input({ ...threeWindows, activeWindowId: "@3" }));
    expect(stepTarget(atEnd, 1)?.key).toBe("@1");
  });

  it("wraps backwards", () => {
    expect(stepTarget(strip, -1)?.key).toBe("@1");
    const atStart = resolveStrip(
      input({ ...threeWindows, activeWindowId: "@1" }),
    );
    expect(stepTarget(atStart, -1)?.key).toBe("@3");
  });

  it("refuses to step a strip of one", () => {
    const solo = resolveStrip(
      input({
        windows: [win("@1", 0, true)],
        activeWindowId: "@1",
        panes: [pane("%1", 0, "@1", true)],
      }),
    );
    expect(stepTarget(solo, 1)).toBeNull();
  });

  it("refuses to step when nothing is active", () => {
    const lost = resolveStrip(
      input({ ...threeWindows, activeWindowId: null }),
    );
    expect(stepTarget(lost, 1)).toBeNull();
  });
});

describe("resolveStep", () => {
  it("sends a relative window step, never a window id", () => {
    // Relative on purpose: the strip the user swiped can be seconds stale, and
    // a killed window id would land nowhere.
    const strip = resolveStrip(input(threeWindows));
    expect(resolveStep(strip, 1)).toEqual({
      send: { type: "window:step", delta: 1 },
    });
    expect(resolveStep(strip, -1)).toEqual({
      send: { type: "window:step", delta: -1 },
    });
  });

  it("sends a relative pane step for a zoomed pane strip", () => {
    const strip = resolveStrip(
      input({
        windows: [win("@1", 0, true)],
        activeWindowId: "@1",
        panes: [pane("%1", 0, "@1", true, true), pane("%2", 1, "@1")],
        activePaneId: "%1",
        zoomedPaneId: "%1",
      }),
    );
    expect(resolveStep(strip, 1)).toEqual({
      send: { type: "pane:step", delta: 1 },
    });
  });

  it("switches session by name, since that is a client-side move", () => {
    const strip = resolveStrip(
      input({
        windows: [win("@1", 0, true)],
        activeWindowId: "@1",
        panes: [pane("%1", 0, "@1", true)],
        sessions: [sess("work"), sess("play")],
        activeSessionId: "work",
      }),
    );
    expect(resolveStep(strip, 1)).toEqual({ setSession: "play" });
  });

  it("returns null rather than sending something harmless-looking", () => {
    expect(resolveStep(resolveStrip(input()), 1)).toBeNull();
  });
});

/*
 * Every relay already installed on someone's machine predates `window:step`,
 * and answers `INVALID_MESSAGE` for it — which looks, from the phone, exactly
 * like the bug this whole strip exists to fix.
 */
describe("older relays", () => {
  it("falls back to selecting the target window by id", () => {
    const strip = resolveStrip(
      input({
        windows: [win("@1", 0, true), win("@2", 1)],
        activeWindowId: "@1",
        panes: [pane("%1", 0, "@1", true)],
      }),
    );
    expect(resolveStep(strip, 1, false)).toEqual({
      send: { type: "window:select", id: "@2" },
    });
    // Wrapping backwards must name the far end, not step past it.
    expect(resolveStep(strip, -1, false)).toEqual({
      send: { type: "window:select", id: "@2" },
    });
  });

  it("falls back to selecting the target pane by id", () => {
    const strip = resolveStrip(
      input({
        windows: [win("@1", 0, true)],
        activeWindowId: "@1",
        panes: [pane("%1", 0, "@1", true, true), pane("%2", 1, "@1")],
        activePaneId: "%1",
        zoomedPaneId: "%1",
      }),
    );
    expect(resolveStep(strip, 1, false)).toEqual({
      send: { type: "pane:select", id: "%2" },
    });
  });

  it("still switches sessions, which never involved the relay", () => {
    const strip = resolveStrip(
      input({
        windows: [win("@1", 0, true)],
        activeWindowId: "@1",
        panes: [pane("%1", 0, "@1", true)],
        sessions: [sess("work"), sess("play")],
        activeSessionId: "work",
      }),
    );
    expect(resolveStep(strip, 1, false)).toEqual({ setSession: "play" });
  });
});
