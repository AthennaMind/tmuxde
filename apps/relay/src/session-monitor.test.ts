import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PaneInfo, WindowInfo } from "@repo/protocol";

const listSessions = vi.fn();
const listWindows = vi.fn<(name: string) => Promise<WindowInfo[]>>();
const listPanes = vi.fn<(name: string) => Promise<PaneInfo[]>>();

vi.mock("./tmux-manager.js", () => ({
  listSessions: () => listSessions(),
  listWindows: (name: string) => listWindows(name),
  listPanes: (name: string) => listPanes(name),
}));

const { createSessionMonitor } = await import("./session-monitor.js");

const WINDOW: WindowInfo = {
  id: "@1",
  index: 0,
  name: "shell",
  active: true,
  paneCount: 2,
  layout: "layout",
  activity: false,
  zoomed: false,
};

function pane(id: string, active: boolean, path: string): PaneInfo {
  return {
    id,
    index: Number(id.slice(1)),
    windowId: "@1",
    active,
    zoomed: false,
    dimensions: { cols: 80, rows: 24 },
    position: { x: 0, y: 0 },
    path,
  };
}

/**
 * The window list alone cannot see pane focus moved with tmux keys, or `cd`
 * in a pane. The browser kept showing the folder of the old pane.
 */
describe("session monitor window poll", () => {
  let panes: PaneInfo[];
  let changes: string[];
  let monitor: ReturnType<typeof createSessionMonitor>;

  beforeEach(async () => {
    vi.useFakeTimers();
    panes = [pane("%1", true, "/repo"), pane("%2", false, "/other")];
    changes = [];
    listSessions.mockResolvedValue([]);
    listWindows.mockResolvedValue([WINDOW]);
    listPanes.mockImplementation(async () => panes);
    monitor = createSessionMonitor({ watchedSessions: () => ["work"] });
    monitor.onWindowsChanged((name) => changes.push(name));
    monitor.start();
    // First sighting seeds the baseline and announces nothing.
    await vi.advanceTimersByTimeAsync(0);
  });

  afterEach(() => {
    monitor.stop();
    vi.useRealTimers();
  });

  it("stays quiet while nothing moves", async () => {
    await vi.advanceTimersByTimeAsync(3000);
    expect(changes).toEqual([]);
  });

  it("announces focus moved to another pane within a second", async () => {
    panes = [pane("%1", false, "/repo"), pane("%2", true, "/other")];
    await vi.advanceTimersByTimeAsync(1000);
    expect(changes).toEqual(["work"]);
  });

  it("announces a folder change in a pane", async () => {
    panes = [pane("%1", true, "/repo/src"), pane("%2", false, "/other")];
    await vi.advanceTimersByTimeAsync(1000);
    expect(changes).toEqual(["work"]);
  });
});
