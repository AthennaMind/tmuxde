import { describe, expect, it } from "vitest";
import type { PaneInfo, SessionInfo, WindowInfo } from "@/protocol";
import type { MachineInfo } from "@/protocol/machines";
import type { MachineSessions } from "@/stores/machine-store";
import {
  activityLabel,
  buildMachine,
  filterOverview,
  overviewPanes,
  liveWindowsOf,
  machineState,
  machineStatusLabel,
  windowCardName,
  windowFocus,
  windowPanes,
  type LiveState,
} from "./overview-model";

const machine = (id: string, online = true): MachineInfo => ({
  id,
  name: id === "local" ? "server-dev" : `Dev ${id}`,
  online,
  hostname: id,
  platform: "linux",
  defaultPath: "/workspace",
  version: "dev",
  features: [],
});

const session = (name: string, windows = 1): SessionInfo => ({
  name,
  id: `$${name}`,
  windows,
  attached: false,
  created: new Date().toISOString(),
  activity: new Date().toISOString(),
});

const window = (
  id: string,
  index: number,
  name: string,
  extra: Partial<WindowInfo> = {},
): WindowInfo => ({
  id,
  index,
  name,
  active: index === 0,
  paneCount: 1,
  layout: "",
  ...extra,
});

const pane = (id: string, windowId: string, extra: Partial<PaneInfo> = {}): PaneInfo => ({
  id,
  index: 0,
  windowId,
  active: true,
  zoomed: false,
  dimensions: { cols: 80, rows: 24 },
  position: { x: 0, y: 0 },
  command: "zsh",
  path: "/home/me/workspace",
  ...extra,
});

const inventory = (patch: Partial<MachineSessions> = {}): MachineSessions => ({
  status: "connected",
  loaded: true,
  sessions: [],
  details: {},
  ...patch,
});

/** Machine "beta" with session `dev`: window 0 runs claude and a shell, window 1 is a shell in /srv/api. */
function beta(): MachineSessions {
  return inventory({
    sessions: [session("dev", 2), session("notes")],
    details: {
      dev: {
        windows: [window("@1", 0, "agents", { paneCount: 2 }), window("@2", 1, "zsh")],
        panes: [
          pane("%1", "@1", { command: "claude", index: 0 }),
          pane("%2", "@1", { index: 1, active: false, path: "/home/me/workspace/web" }),
          pane("%3", "@2", { path: "/srv/api" }),
        ],
      },
      notes: {
        windows: [window("@3", 0, "vim")],
        panes: [pane("%4", "@3", { command: "vim", path: "/home/me/notes" })],
      },
    },
  });
}

describe("buildMachine", () => {
  it("prefers refreshed inventory over cached details for unattached sessions", () => {
    const fresh = beta();
    const live: LiveState = {
      machineId: "beta",
      status: "connected",
      sessions: fresh.sessions,
      sessionsLoaded: true,
      activeSessionId: null,
      attachedSession: null,
      details: { dev: { windows: [window("@99", 0, "stale")], panes: [] } },
      windows: [],
      panes: [],
      activeWindowId: null,
      activePaneId: null,
      zoomedPaneId: null,
      pendingKey: null,
    };
    const view = buildMachine(machine("beta"), fresh, live);
    expect(view.sessions[0]!.windows.map((item) => item.window.id)).toEqual(["@1", "@2"]);
  });

  it("lists sessions and windows from the inventory", () => {
    const view = buildMachine(machine("beta"), beta(), null);
    expect(view.state).toBe("ready");
    expect(view.connected).toBe(true);
    expect(view.sessionCount).toBe(2);
    const [dev] = view.sessions;
    expect(dev!.windowCount).toBe(2);
    expect(dev!.windows.map((w) => [w.window.index, w.label, w.detail])).toEqual([
      [0, "agents", "Claude Code · 2 folders"],
      [1, "Terminal", "/srv/api"],
    ]);
    expect(dev!.windows[0]!.focusId).toBe("%1");
    expect(dev!.windows[0]!.showing).toBe(false);
  });

  it("names offline, unreachable and loading machines", () => {
    expect(buildMachine(machine("a", false), beta(), null).state).toBe("offline");
    expect(buildMachine(machine("a", false), beta(), null).sessions).toEqual([]);
    expect(buildMachine(machine("a"), undefined, null).state).toBe("loading");
    expect(
      buildMachine(machine("a"), inventory({ loaded: false, status: "disconnected" }), null).state,
    ).toBe("unreachable");
    expect(
      buildMachine(machine("a"), inventory({ loaded: false, status: "connecting" }), null).state,
    ).toBe("loading");
    expect(
      buildMachine(machine("a"), inventory({ loaded: false, status: "reconnecting" }), null).state,
    ).toBe("unreachable");
  });

  it("marks a session whose windows are not in yet", () => {
    const view = buildMachine(machine("a"), inventory({ sessions: [session("fresh", 3)] }), null);
    expect(view.sessions[0]).toMatchObject({ loading: true, windowCount: 3, windows: [] });
  });

  it("takes focus, zoom and panes of the window on screen from live state", () => {
    const live: LiveState = {
      machineId: "beta",
      sessions: [],
      sessionsLoaded: false,
      status: "connected",
      activeSessionId: "dev",
      attachedSession: "dev",
      details: {},
      windows: [],
      panes: [
        pane("%1", "@1", { command: "zsh", active: false }),
        pane("%2", "@1", { index: 1, active: true, path: "/tmp" }),
      ],
      activeWindowId: "@1",
      activePaneId: "%2",
      zoomedPaneId: "%2",
      pendingKey: "%1",
    };
    const view = buildMachine(machine("beta"), beta(), live);
    const [agents, shell] = view.sessions[0]!.windows;
    expect(agents).toMatchObject({
      focusId: "%2",
      zoomedId: "%2",
      zoomed: true,
      showing: true,
      pendingId: "%1",
    });
    // Live structure and folder, listed command.
    expect(agents!.panes.map((p) => [p.id, p.command, p.path])).toEqual([
      ["%1", "claude", "/home/me/workspace"],
      ["%2", "zsh", "/tmp"],
    ]);
    expect(shell!.showing).toBe(false);
    // Live state of one machine never leaks into another.
    const other = buildMachine(machine("alpha"), beta(), live);
    expect(other.sessions[0]!.windows[0]!.showing).toBe(false);
    expect(other.sessions[0]!.windows[0]!.pendingId).toBeNull();
  });

  it("does not show the old session as on screen while a switch attaches", () => {
    const live: LiveState = {
      machineId: "beta",
      sessions: [],
      sessionsLoaded: false,
      status: "connected",
      activeSessionId: "notes",
      attachedSession: "dev",
      details: {},
      windows: [],
      panes: [],
      activeWindowId: "@1",
      activePaneId: "%1",
      zoomedPaneId: null,
      pendingKey: null,
    };
    const view = buildMachine(machine("beta"), beta(), live);
    expect(view.sessions.flatMap((s) => s.windows).some((w) => w.showing)).toBe(false);
  });

  it("draws no window of the session attached before while a switch lands", () => {
    // `notes` is attached now. Until the next `window:changed` the pane
    // store still holds the windows and panes of `dev`.
    const listed = beta();
    const live: LiveState = {
      machineId: "beta",
      sessions: [],
      sessionsLoaded: false,
      status: "connected",
      activeSessionId: "notes",
      attachedSession: "notes",
      details: {},
      windows: listed.details.dev!.windows,
      panes: listed.details.dev!.panes.filter((p) => p.windowId === "@1"),
      activeWindowId: "@1",
      activePaneId: "%1",
      zoomedPaneId: null,
      pendingKey: null,
    };
    const [dev, notes] = buildMachine(machine("beta"), listed, live).sessions;
    expect(notes!.windows.map((w) => w.window.id)).toEqual(["@3"]);
    expect(notes!.windowCount).toBe(1);
    expect(notes!.windows[0]!.panes.map((p) => p.id)).toEqual(["%4"]);
    expect(notes!.windows[0]!.showing).toBe(false);
    expect(dev!.windows.map((w) => w.window.id)).toEqual(["@1", "@2"]);
    expect(dev!.windows.some((w) => w.showing)).toBe(false);
  });

  it("reads zoom from the window flag for windows off screen", () => {
    const listed = beta();
    listed.details.dev!.windows[0] = { ...listed.details.dev!.windows[0]!, zoomed: true };
    const view = buildMachine(machine("beta"), listed, null);
    expect(view.sessions[0]!.windows[0]).toMatchObject({ zoomed: true, zoomedId: "%1" });
  });
});

describe("liveWindowsOf", () => {
  const listing = beta().details;
  const own = [window("@3", 0, "vim"), window("@5", 1, "new")];

  it("gives the attached session its live windows", () => {
    expect(liveWindowsOf("notes", "notes", own, listing)).toEqual(own);
    // A window no listing has yet is still its own.
    expect(liveWindowsOf("fresh", "fresh", [window("@7", 0, "zsh")], listing)).toHaveLength(1);
  });

  it("gives no live windows to a session that is not attached", () => {
    expect(liveWindowsOf("dev", "notes", own, listing)).toEqual([]);
    expect(liveWindowsOf("notes", null, own, listing)).toEqual([]);
    expect(liveWindowsOf("notes", "notes", [], listing)).toEqual([]);
  });

  it("refuses live windows another session's listing has", () => {
    const stale = listing.dev!.windows;
    expect(liveWindowsOf("notes", "notes", stale, listing)).toEqual([]);
    expect(liveWindowsOf("notes", "notes", [own[0]!, stale[0]!], listing)).toEqual([]);
  });
});

describe("windowFocus", () => {
  const w = window("@1", 0, "agents", { paneCount: 2 });
  const panes = [pane("%1", "@1", { active: false }), pane("%2", "@1", { index: 1, active: true })];

  it("reads the window on screen from the pane store", () => {
    expect(windowFocus(w, panes, { activePaneId: "%1", zoomedPaneId: "%1" })).toEqual({
      focusId: "%1",
      zoomedId: "%1",
      zoomed: true,
    });
  });

  it("reads every other window from the listing", () => {
    expect(windowFocus(w, panes, null)).toEqual({ focusId: "%2", zoomedId: null, zoomed: false });
    // tmux flags the window. The zoomed pane is its active pane.
    expect(windowFocus({ ...w, zoomed: true }, panes, null)).toEqual({
      focusId: "%2",
      zoomedId: "%2",
      zoomed: true,
    });
  });
});

describe("windowPanes", () => {
  it("drops live panes of another window", () => {
    const w = window("@2", 1, "zsh");
    const listed = [pane("%3", "@2")];
    expect(windowPanes(w, listed, [pane("%1", "@1")])).toEqual(listed);
  });
});

describe("filterOverview", () => {
  const machines = () => [
    buildMachine(machine("beta"), beta(), null),
    buildMachine(
      machine("alpha"),
      inventory({
        sessions: [session("ops")],
        details: {
          ops: {
            windows: [window("@9", 0, "logs")],
            panes: [pane("%9", "@9", { command: "tail" })],
          },
        },
      }),
      null,
    ),
  ];

  it("keeps everything without a query", () => {
    const result = filterOverview(machines(), "  ");
    expect(result.machines).toHaveLength(2);
    expect(result.windows).toBe(4);
    expect(result.first?.window.window.id).toBe("@1");
  });

  it("keeps every window of a session whose name matches", () => {
    const result = filterOverview(machines(), "DEV");
    expect(result.machines.map((m) => m.machine.id)).toEqual(["beta"]);
    expect(result.machines[0]!.sessions.map((s) => s.session.name)).toEqual(["dev"]);
    expect(result.windows).toBe(2);
  });

  it("matches window name, process label, command and folder", () => {
    const ids = (query: string) =>
      filterOverview(machines(), query).machines.flatMap((m) =>
        m.sessions.flatMap((s) => s.windows.map((w) => w.window.id)),
      );
    expect(ids("logs")).toEqual(["@9"]);
    expect(ids("claude code")).toEqual(["@1"]);
    expect(ids("tail")).toEqual(["@9"]);
    expect(ids("/srv/api")).toEqual(["@2"]);
    expect(ids("~/workspace/web")).toEqual(["@1"]);
    expect(ids("NOTES")).toEqual(["@3"]);
    expect(ids("nothing here")).toEqual([]);
  });

  it("skips machines that are not connected for Enter", () => {
    const [b, a] = machines();
    const result = filterOverview([{ ...b!, connected: false }, a!], "");
    expect(result.first?.machine.machine.id).toBe("alpha");
  });
});

describe("labels", () => {
  it("names a card for screen readers", () => {
    const [agents] = buildMachine(machine("beta"), beta(), null).sessions[0]!.windows;
    expect(windowCardName(agents!)).toBe("Window 0 agents, Claude Code · 2 folders, 2 panes");
    expect(windowCardName({ ...agents!, zoomed: true, showing: true })).toBe(
      "Window 0 agents, Claude Code · 2 folders, 2 panes, zoomed, on screen",
    );
  });

  it("names a machine's state the same way everywhere", () => {
    // The session tree said "Offline" for a listed machine whose socket
    // dropped, while the overview said "Reconnecting".
    expect(machineStatusLabel(machineState(true, true, true, "connected"), true)).toBe("Online");
    expect(machineStatusLabel(machineState(true, true, true, "reconnecting"), false)).toBe(
      "Reconnecting",
    );
    expect(machineStatusLabel(machineState(true, false, true, "disconnected"), false)).toBe(
      "Unreachable",
    );
    // No socket has answered yet: still connecting.
    expect(machineStatusLabel(machineState(true, false, false, "disconnected"), false)).toBe(
      "Connecting",
    );
    expect(machineStatusLabel(machineState(true, false, true, "connecting"), false)).toBe(
      "Connecting",
    );
    expect(machineStatusLabel(machineState(false, true, true, "connected"), false)).toBe("Offline");
  });

  it("reads activity as a phrase", () => {
    expect(activityLabel(new Date().toISOString())).toBe("active now");
    expect(activityLabel(new Date(Date.now() - 5 * 60_000).toISOString())).toBe("active 5m ago");
  });
});

describe("overviewPanes", () => {
  it("flattens splits and sessions while retaining navigation context", () => {
    const cards = overviewPanes([buildMachine(machine("beta"), beta(), null)]);
    expect(
      cards.map((card) => [card.session.session.name, card.window.window.id, card.pane.id]),
    ).toEqual([
      ["dev", "@1", "%1"],
      ["dev", "@1", "%2"],
      ["dev", "@2", "%3"],
      ["notes", "@3", "%4"],
    ]);
  });
  it("matches only the pane process or path, while location matches keep its panes", () => {
    const machines = [buildMachine(machine("beta"), beta(), null)];
    expect(overviewPanes(machines, " CLAUDE ").map((card) => card.pane.id)).toEqual(["%1"]);
    expect(overviewPanes(machines, "/web").map((card) => card.pane.id)).toEqual(["%2"]);
    expect(overviewPanes(machines, "agents")).toHaveLength(2);
    expect(overviewPanes(machines, "dev beta")).toHaveLength(4);
    expect(overviewPanes(machines, "notes").map((card) => card.pane.id)).toEqual(["%4"]);
  });
  it("keeps identical pane IDs on different machines distinct", () => {
    const cards = overviewPanes([
      buildMachine(machine("alpha"), beta(), null),
      buildMachine(machine("beta"), beta(), null),
    ]);
    expect(new Set(cards.map((card) => card.key)).size).toBe(8);
    expect(cards[4]!.machine.machine.id).toBe("beta");
  });
});
