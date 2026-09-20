import { describe, it, expect, beforeEach, vi } from "vitest";
import type { WebSocket } from "ws";
import type {
  ClientMessage,
  PaneInfo,
  ServerMessage,
  SessionInfo,
  TerminalSize,
  WindowInfo,
} from "@repo/protocol";
import type { ConnectionState } from "./connection-manager.js";
import type { PtyBridge, PtyBridgeOptions } from "./pty-bridge.js";
import { FULL_GRANT } from "./grant.js";

const capturePane = vi.fn<(name: string) => Promise<string>>();
const sessionExists = vi.fn<(name: string) => Promise<boolean>>();
const listSessions = vi.fn<() => Promise<SessionInfo[]>>();
const listPanes =
  vi.fn<(session: string, windowId?: string) => Promise<PaneInfo[]>>();
const currentWindowId = vi.fn<(session: string) => Promise<string>>();
const stepWindow = vi.fn<(session: string, delta: number) => Promise<void>>();
const stepPane = vi.fn<(session: string, delta: number) => Promise<void>>();
const selectWindow = vi.fn<(id: string) => Promise<void>>();
const selectPane = vi.fn<(id: string) => Promise<void>>();
const zoomPane =
  vi.fn<
    (
      session: string,
      opts?: { paneId?: string; desired?: boolean },
    ) => Promise<void>
  >();
const listWindows = vi.fn<(session: string) => Promise<WindowInfo[]>>();
const capturePaneById = vi.fn<(id: string) => Promise<string>>();
type ScrollState = {
  position: number;
  historySize: number;
  paneHeight: number;
  inMode: boolean;
};
const AT_BOTTOM: ScrollState = {
  position: 0,
  historySize: 400,
  paneHeight: 40,
  inMode: false,
};
const scrollHistory =
  vi.fn<(session: string, lines: number) => Promise<ScrollState>>();
const scrollToPosition =
  vi.fn<(session: string, position: number) => Promise<ScrollState>>();
const readScrollState = vi.fn<(session: string) => Promise<ScrollState>>();
const exitCopyMode = vi.fn<(session: string) => Promise<void>>();
const createPtyBridge =
  vi.fn<
    (name: string, size?: TerminalSize, opts?: PtyBridgeOptions) => PtyBridge
  >();

vi.mock("./tmux-manager.js", () => ({
  capturePane: (name: string) => capturePane(name),
  sessionExists: (name: string) => sessionExists(name),
  listSessions: () => listSessions(),
  listPanes: (session: string, windowId?: string) =>
    listPanes(session, windowId),
  currentWindowId: (session: string) => currentWindowId(session),
  stepWindow: (session: string, delta: number) => stepWindow(session, delta),
  stepPane: (session: string, delta: number) => stepPane(session, delta),
  selectWindow: (id: string) => selectWindow(id),
  selectPane: (id: string) => selectPane(id),
  zoomPane: (session: string, opts?: { paneId?: string; desired?: boolean }) =>
    zoomPane(session, opts),
  listWindows: (session: string) => listWindows(session),
  capturePaneById: (id: string) => capturePaneById(id),
  scrollHistory: (session: string, lines: number) =>
    scrollHistory(session, lines),
  scrollToPosition: (session: string, position: number) =>
    scrollToPosition(session, position),
  readScrollState: (session: string) => readScrollState(session),
  exitCopyMode: (session: string) => exitCopyMode(session),
}));

vi.mock("./pty-bridge.js", () => ({
  createPtyBridge: (
    name: string,
    size?: TerminalSize,
    opts?: PtyBridgeOptions,
  ) => createPtyBridge(name, size, opts),
}));

const listDirectory = vi.fn<(path: string) => Promise<unknown[]>>();
vi.mock("./file-service.js", () => ({
  isPathAllowed: () => true,
  listDirectory: (path: string) => listDirectory(path),
  defaultBrowsePath: () => "/home/someone",
}));

const createReadOnlyClone =
  vi.fn<(target: string, grantId: string, connId: string) => Promise<string>>();
vi.mock("./tmux-clone.js", () => ({
  createReadOnlyClone: (target: string, grantId: string, connId: string) =>
    createReadOnlyClone(target, grantId, connId),
  destroyClone: () => Promise.resolve(),
  isCloneSession: (name: string) => name.startsWith("__mtmux_"),
  CLONE_PREFIX: "__mtmux_",
}));

const recorderStart = vi.fn();
const recorderStop = vi.fn();
vi.mock("./recorder.js", async () => {
  class RecordingError extends Error {
    constructor(
      readonly code: string,
      message: string,
    ) {
      super(message);
    }
  }
  return {
    RecordingError,
    start: (o: unknown) => recorderStart(o),
    stop: (id: string, reason?: string) => recorderStop(id, reason),
    listActive: () => [],
    isRecording: () => false,
  };
});

const recordingsList = vi.fn<() => Promise<unknown[]>>();
const recordingsGet = vi.fn<(id: string) => Promise<unknown>>();
const recordingsRemove = vi.fn<(id: string) => Promise<boolean>>();
vi.mock("./recordings-index.js", () => ({
  list: () => recordingsList(),
  get: (id: string) => recordingsGet(id),
  remove: (id: string) => recordingsRemove(id),
  recordingPath: (filename: string) => `/tmp/mtmux-router-test/${filename}`,
}));

const { routeMessage } = await import("./message-router.js");

/** A PtyBridge stub whose lifecycle callbacks are fired by the test. */
function makeBridge(name: string) {
  const readyCallbacks: (() => void)[] = [];
  const bridge = {
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    markDetaching: vi.fn(),
    onData: vi.fn(),
    onExit: vi.fn(),
    onReady: vi.fn((cb: () => void) => {
      readyCallbacks.push(cb);
    }),
    onSpawnError: vi.fn(),
    pid: 1234,
    sessionName: name,
    detaching: false,
    spawnError: null,
  } as unknown as PtyBridge & { resize: ReturnType<typeof vi.fn> };
  return {
    bridge,
    fireReady: () => readyCallbacks.forEach((cb) => cb()),
  };
}

let sent: ServerMessage[];
let conn: ConnectionState;

function makeConn(): ConnectionState {
  const ws = {
    readyState: 1, // WebSocket.OPEN
    bufferedAmount: 0,
    send: (raw: string) => {
      sent.push(JSON.parse(raw) as ServerMessage);
    },
  } as unknown as WebSocket;

  return {
    id: "conn-test",
    ws,
    authenticated: true,
    grant: FULL_GRANT,
    tokenId: null,
    pty: null,
    watchers: new Map(),
    uploads: new Map(),
    rateLimiter: {} as ConnectionState["rateLimiter"],
    label: null,
    connectedAt: Date.now(),
    attachedSession: null,
    lastSize: null,
    cloneSession: null,
    activeWindowId: null,
    remoteAddress: null,
    lastActivityAt: Date.now(),
    closing: false,
    enqueue: () => {},
    drain: async () => {},
  };
}

const route = (msg: ClientMessage) => routeMessage(conn, msg);

beforeEach(() => {
  vi.clearAllMocks();
  sent = [];
  conn = makeConn();
  sessionExists.mockResolvedValue(true);
  capturePane.mockResolvedValue("REPLAYED SCROLLBACK");
  listSessions.mockResolvedValue([
    session("work", "$1"),
    session("other", "$2"),
  ]);
  listPanes.mockResolvedValue([pane("%1", "@1")]);
  listWindows.mockResolvedValue([window("@1")]);
  currentWindowId.mockResolvedValue("@1");
  stepWindow.mockResolvedValue(undefined);
  stepPane.mockResolvedValue(undefined);
  selectWindow.mockResolvedValue(undefined);
  selectPane.mockResolvedValue(undefined);
  zoomPane.mockResolvedValue(undefined);
  capturePaneById.mockResolvedValue("PANE CONTENT");
  scrollHistory.mockResolvedValue({ ...AT_BOTTOM, position: 12, inMode: true });
  scrollToPosition.mockResolvedValue({
    ...AT_BOTTOM,
    position: 200,
    inMode: true,
  });
  readScrollState.mockResolvedValue(AT_BOTTOM);
  exitCopyMode.mockResolvedValue(undefined);
  listDirectory.mockResolvedValue([]);
  createReadOnlyClone.mockResolvedValue("__mtmux_clone");
});

function session(name: string, id: string): SessionInfo {
  return {
    name,
    id,
    windows: 1,
    attached: false,
    created: new Date(0).toISOString(),
    activity: new Date(0).toISOString(),
  };
}

function pane(id: string, windowId: string): PaneInfo {
  return {
    id,
    index: 0,
    windowId,
    active: true,
    zoomed: false,
    dimensions: { cols: 80, rows: 24 },
    position: { x: 0, y: 0 },
  };
}

function window(id: string, index = 0, active = true): WindowInfo {
  return {
    id,
    index,
    name: "bash",
    active,
    paneCount: 1,
    layout: "",
  };
}

describe("session:attach", () => {
  it("acks before replaying the capture", async () => {
    const { bridge, fireReady } = makeBridge("work");
    createPtyBridge.mockReturnValue(bridge);

    await route({ type: "session:attach", name: "work", capture: true });
    fireReady();

    const types = sent.map((m) => m.type);
    expect(types).toEqual(["session:attached", "terminal:output"]);
    // The client drops output until it has seen the ack, so the ordering here
    // is the difference between a painted screen and a blank one.
    expect(types.indexOf("session:attached")).toBeLessThan(
      types.indexOf("terminal:output"),
    );
  });

  it("echoes the attachId so the client can reject stale acks", async () => {
    const { bridge, fireReady } = makeBridge("work");
    createPtyBridge.mockReturnValue(bridge);

    await route({
      type: "session:attach",
      name: "work",
      capture: true,
      attachId: "a7",
    });
    fireReady();

    const ack = sent.find((m) => m.type === "session:attached");
    expect(ack).toMatchObject({ name: "work", attachId: "a7" });
  });

  it("still attaches when the capture fails", async () => {
    const { bridge, fireReady } = makeBridge("huge");
    createPtyBridge.mockReturnValue(bridge);
    capturePane.mockRejectedValue(
      Object.assign(new Error("stdout maxBuffer length exceeded"), {
        code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
      }),
    );

    await route({ type: "session:attach", name: "huge", capture: true });
    fireReady();

    // The old PTY is already dead by the time the capture runs — aborting here
    // is what left large sessions with a permanently blank terminal.
    expect(conn.pty).toBe(bridge);
    expect(conn.attachedSession).toBe("huge");
    expect(sent.map((m) => m.type)).toEqual(["session:attached"]);
  });

  it("leaves no stale attachedSession when the session is gone", async () => {
    const { bridge, fireReady } = makeBridge("old");
    createPtyBridge.mockReturnValue(bridge);
    await route({ type: "session:attach", name: "old", capture: false });
    fireReady();
    expect(conn.attachedSession).toBe("old");

    sent = [];
    sessionExists.mockResolvedValue(false);
    await route({ type: "session:attach", name: "gone", capture: false });

    expect(conn.pty).toBeNull();
    expect(conn.attachedSession).toBeNull();
    expect(sent.map((m) => m.type)).toEqual(["error"]);
  });

  it("leaves no stale attachedSession when the PTY fails to spawn", async () => {
    const { bridge, fireReady } = makeBridge("old");
    createPtyBridge.mockReturnValue(bridge);
    await route({ type: "session:attach", name: "old", capture: false });
    fireReady();

    const dead = makeBridge("broken").bridge as PtyBridge & {
      spawnError: Error | null;
    };
    dead.spawnError = new Error("no pty");
    createPtyBridge.mockReturnValue(dead);
    await route({ type: "session:attach", name: "broken", capture: false });

    expect(conn.pty).toBeNull();
    expect(conn.attachedSession).toBeNull();
  });
});

describe("session:detach", () => {
  it("clears attachedSession even with no live PTY", async () => {
    conn.attachedSession = "orphan";
    conn.pty = null;

    await route({ type: "session:detach" });

    expect(conn.attachedSession).toBeNull();
    expect(conn.lastSize).toBeNull();
  });
});

describe("terminal:resize", () => {
  it("applies a changed size once and drops the repeats", async () => {
    const { bridge, fireReady } = makeBridge("work");
    createPtyBridge.mockReturnValue(bridge);
    await route({
      type: "session:attach",
      name: "work",
      size: { cols: 80, rows: 24 },
      capture: false,
    });
    fireReady();

    const resize = (bridge as unknown as { resize: ReturnType<typeof vi.fn> })
      .resize;

    await route({ type: "terminal:resize", size: { cols: 100, rows: 40 } });
    await route({ type: "terminal:resize", size: { cols: 100, rows: 40 } });
    await route({ type: "terminal:resize", size: { cols: 100, rows: 40 } });

    // Each resize is a SIGWINCH that makes tmux redraw for every attached
    // client, so identical sizes must not reach the PTY.
    expect(resize).toHaveBeenCalledTimes(1);
    expect(resize).toHaveBeenCalledWith({ cols: 100, rows: 40 });

    await route({ type: "terminal:resize", size: { cols: 120, rows: 40 } });
    expect(resize).toHaveBeenCalledTimes(2);
  });

  it("drops a resize that matches the size sent with the attach", async () => {
    const { bridge, fireReady } = makeBridge("work");
    createPtyBridge.mockReturnValue(bridge);
    await route({
      type: "session:attach",
      name: "work",
      size: { cols: 80, rows: 24 },
      capture: false,
    });
    fireReady();

    await route({ type: "terminal:resize", size: { cols: 80, rows: 24 } });

    expect(
      (bridge as unknown as { resize: ReturnType<typeof vi.fn> }).resize,
    ).not.toHaveBeenCalled();
  });
});

/**
 * The scoping regressions.
 *
 * Each of these was a live hole before grants existed, and two of them —
 * `pane:capture` and the file gate — applied to *every* connection, not just
 * shared ones.
 */
describe("scoped grants", () => {
  function scoped(over: Partial<ConnectionState["grant"]> = {}) {
    conn.grant = {
      ...FULL_GRANT,
      id: "grn_share",
      scope: { kind: "sessions", sessions: [{ id: "$1", name: "work" }] },
      files: "none",
      ...over,
    };
  }

  it("refuses to capture a pane outside the attached session", async () => {
    // Finding #2. `capturePaneById("%9")` passed the id straight to tmux,
    // which resolves pane ids server-wide — so any pane's scrollback on the
    // machine came back, and `attachedSession` was never a boundary at all.
    const { bridge, fireReady } = makeBridge("work");
    createPtyBridge.mockReturnValue(bridge);
    await route({ type: "session:attach", name: "work", capture: false });
    fireReady();
    sent.length = 0;

    // listPanes only ever reports %1 for this session.
    await route({ type: "pane:capture", id: "%9" });

    expect(capturePaneById).not.toHaveBeenCalled();
    expect(sent[0]).toMatchObject({ type: "error", code: "PANE_NOT_FOUND" });
  });

  it("still captures a pane that does belong to the session", async () => {
    const { bridge, fireReady } = makeBridge("work");
    createPtyBridge.mockReturnValue(bridge);
    await route({ type: "session:attach", name: "work", capture: false });
    fireReady();
    sent.length = 0;

    await route({ type: "pane:capture", id: "%1" });

    expect(capturePaneById).toHaveBeenCalledWith("%1");
    expect(sent[0]).toMatchObject({ type: "pane:captured", id: "%1" });
  });

  it("hides out-of-scope sessions from the list rather than erroring", async () => {
    scoped();
    await route({ type: "session:list" });

    const list = sent.find((m) => m.type === "session:list") as {
      sessions: SessionInfo[];
    };
    expect(list.sessions.map((s) => s.name)).toEqual(["work"]);
  });

  it("answers SESSION_NOT_FOUND for an out-of-scope attach", async () => {
    // Not "denied". A scoped holder who could tell those two apart could
    // enumerate every session name on the machine by probing.
    scoped();
    await route({ type: "session:attach", name: "other", capture: false });

    expect(createPtyBridge).not.toHaveBeenCalled();
    expect(sent[0]).toMatchObject({
      type: "error",
      code: "SESSION_NOT_FOUND",
    });
  });

  it("never calls the file service when files are off", async () => {
    scoped();
    await route({ type: "file:list", path: "/home/someone" });

    expect(listDirectory).not.toHaveBeenCalled();
    expect(sent[0]).toMatchObject({ type: "error", code: "ACCESS_DENIED" });
  });

  it("never writes to the PTY on a read-only grant", async () => {
    scoped({ readOnly: true });
    const { bridge, fireReady } = makeBridge("work");
    createPtyBridge.mockReturnValue(bridge);
    await route({ type: "session:attach", name: "work", capture: false });
    fireReady();

    await route({ type: "terminal:input", data: "rm -rf ~\r" });

    expect(
      (bridge as unknown as { write: ReturnType<typeof vi.fn> }).write,
    ).not.toHaveBeenCalled();
  });

  it("attaches a read-only grant through a locked-down clone", async () => {
    // Never `attach-session -r` against the target itself: under -r tmux
    // still honours switch-client, and ( / ) are bound to it by default.
    scoped({ readOnly: true });
    const { bridge, fireReady } = makeBridge("work");
    createPtyBridge.mockReturnValue(bridge);

    await route({ type: "session:attach", name: "work", capture: false });
    fireReady();

    expect(createReadOnlyClone).toHaveBeenCalledWith(
      "work",
      "grn_share",
      "conn-test",
    );
    const [target, , opts] = createPtyBridge.mock.calls[0]!;
    expect(target).toBe("__mtmux_clone");
    expect(opts).toMatchObject({ readOnly: true });
    // The *real* name is what scope checks and broadcasts compare against.
    expect(conn.attachedSession).toBe("work");
  });

  it("refuses a second auth frame instead of rubber-stamping it", async () => {
    // Finding #1's other half. This used to answer auth:success without
    // checking anything, because the tunnel agent had already authenticated
    // the socket with the machine's full token.
    await route({ type: "auth", token: "anything at all" });
    expect(sent[0]).toMatchObject({ type: "error" });
    expect(sent[0]).not.toMatchObject({ type: "auth:success" });
  });
});

describe("tmux:scroll", () => {
  it("scrolls the session the connection is attached to", async () => {
    conn.attachedSession = "work";
    await route({ type: "tmux:scroll", lines: 7 });
    expect(scrollHistory).toHaveBeenCalledWith("work", 7);
  });

  it("passes a negative count through, so scrolling back down works", async () => {
    conn.attachedSession = "work";
    await route({ type: "tmux:scroll", lines: -3 });
    expect(scrollHistory).toHaveBeenCalledWith("work", -3);
  });

  it("refuses when nothing is attached rather than guessing a session", async () => {
    await route({ type: "tmux:scroll", lines: 7 });
    expect(scrollHistory).not.toHaveBeenCalled();
    expect(sent.at(-1)).toMatchObject({ type: "error", code: "NOT_ATTACHED" });
  });

  it("reports where the view ended up, so the scrollbar can draw itself", async () => {
    conn.attachedSession = "work";
    await route({ type: "tmux:scroll", lines: 7 });
    expect(sent.at(-1)).toMatchObject({
      type: "tmux:scroll-state",
      position: 12,
      historySize: 400,
      paneHeight: 40,
      inMode: true,
    });
  });

  it("jumps to an absolute position for a scrollbar drag", async () => {
    conn.attachedSession = "work";
    await route({ type: "tmux:scroll-to", position: 200 });
    expect(scrollToPosition).toHaveBeenCalledWith("work", 200);
    expect(sent.at(-1)).toMatchObject({
      type: "tmux:scroll-state",
      position: 200,
    });
  });

  it("answers a bare state request without moving anything", async () => {
    conn.attachedSession = "work";
    await route({ type: "tmux:scroll-state" });
    expect(scrollHistory).not.toHaveBeenCalled();
    expect(scrollToPosition).not.toHaveBeenCalled();
    expect(sent.at(-1)).toMatchObject({
      type: "tmux:scroll-state",
      position: 0,
      historySize: 400,
    });
  });

  it("reports position 0 outside copy mode, whatever tmux last remembered", async () => {
    conn.attachedSession = "work";
    readScrollState.mockResolvedValue({ ...AT_BOTTOM, position: 99 });
    await route({ type: "tmux:scroll-state" });
    expect(sent.at(-1)).toMatchObject({
      type: "tmux:scroll-state",
      position: 0,
      inMode: false,
    });
  });

  it("leaves copy mode on request", async () => {
    conn.attachedSession = "work";
    await route({ type: "tmux:exit-copy-mode" });
    expect(exitCopyMode).toHaveBeenCalledWith("work");
  });

  it("refuses to leave copy mode with nothing attached", async () => {
    await route({ type: "tmux:exit-copy-mode" });
    expect(exitCopyMode).not.toHaveBeenCalled();
    expect(sent.at(-1)).toMatchObject({ type: "error", code: "NOT_ATTACHED" });
  });
});

/**
 * The regression this whole area exists for.
 *
 * Every pane reply used to derive its window from
 * `panes.find(p => p.active)?.windowId` over an *unscoped* pane listing.
 * `#{pane_active}` is per-window, so a three-window session had three active
 * panes and that expression always answered "window 1" — the browser
 * highlighted a window it was not looking at, and the swipe stepped panes of a
 * window that was not on screen.
 */
describe("window scoping", () => {
  const threeWindows = () => [
    window("@1", 0, false),
    window("@2", 1, true),
    window("@3", 2, false),
  ];

  beforeEach(() => {
    conn.attachedSession = "work";
    listWindows.mockResolvedValue(threeWindows());
    currentWindowId.mockResolvedValue("@2");
    // What an unscoped `list-panes -s` used to return: one "active" pane per
    // window. If anything still infers from this, the assertions below fail.
    listPanes.mockImplementation(async (_session, windowId) => {
      const all = [pane("%1", "@1"), pane("%2", "@2"), pane("%3", "@3")];
      return windowId ? all.filter((p) => p.windowId === windowId) : all;
    });
  });

  it("scopes pane:list to the window tmux is actually showing", async () => {
    await route({ type: "pane:list" });
    const reply = sent.at(-1) as {
      type: string;
      windowId: string;
      panes: PaneInfo[];
    };
    expect(reply.type).toBe("pane:list");
    expect(reply.windowId).toBe("@2");
    expect(reply.panes.map((p) => p.id)).toEqual(["%2"]);
    expect(reply.panes.filter((p) => p.active)).toHaveLength(1);
  });

  it("does not snap the window back to the first one after window:select", async () => {
    currentWindowId.mockResolvedValue("@3");
    listWindows.mockResolvedValue([
      window("@1", 0, false),
      window("@2", 1, false),
      window("@3", 2, true),
    ]);
    await route({ type: "window:select", id: "@3" });

    const paneChanged = sent.filter((m) => m.type === "pane:changed");
    expect(paneChanged).toHaveLength(1);
    // The old code sent "@1" here, immediately undoing the window:changed that
    // preceded it.
    expect(paneChanged[0]).toMatchObject({ windowId: "@3" });
    expect(conn.activeWindowId).toBe("@3");
  });

  it("publishes the window list alongside every pane change", async () => {
    await route({ type: "pane:zoom" });
    expect(sent.map((m) => m.type)).toEqual(["window:changed", "pane:changed"]);
  });

  it("passes the pane and the wanted state through to tmux", async () => {
    // Both are what make the request idempotent. Dropping either here turns it
    // back into a toggle against whatever pane tmux had active, which is the
    // bug the fields were added for.
    await route({ type: "pane:zoom", id: "%4", zoomed: true });
    expect(zoomPane).toHaveBeenCalledWith("work", {
      paneId: "%4",
      desired: true,
    });
  });

  it("asks for a toggle when an older client names neither", async () => {
    await route({ type: "pane:zoom" });
    expect(zoomPane).toHaveBeenCalledWith("work", {});
  });

  it("carries `zoomed: false` rather than dropping it as falsy", async () => {
    // `...(msg.zoomed ? … )` would silently turn "unzoom this" into "toggle",
    // which un-zooms exactly when it should not.
    await route({ type: "pane:zoom", id: "%4", zoomed: false });
    expect(zoomPane).toHaveBeenCalledWith("work", {
      paneId: "%4",
      desired: false,
    });
  });

  it("steps windows relatively, so a stale client list cannot mistarget", async () => {
    await route({ type: "window:step", delta: 1 });
    expect(stepWindow).toHaveBeenCalledWith("work", 1);
    expect(selectWindow).not.toHaveBeenCalled();
    expect(sent.map((m) => m.type)).toEqual(["window:changed", "pane:changed"]);
  });

  it("steps backwards on a negative delta", async () => {
    await route({ type: "window:step", delta: -1 });
    expect(stepWindow).toHaveBeenCalledWith("work", -1);
  });

  it("steps panes within the current window only", async () => {
    await route({ type: "pane:step", delta: 1 });
    expect(stepPane).toHaveBeenCalledWith("work", 1);
    const paneChanged = sent.find((m) => m.type === "pane:changed") as {
      panes: PaneInfo[];
    };
    expect(paneChanged.panes.map((p) => p.id)).toEqual(["%2"]);
  });

  it("refuses to step with nothing attached", async () => {
    conn.attachedSession = null;
    await route({ type: "window:step", delta: 1 });
    await route({ type: "pane:step", delta: 1 });
    expect(stepWindow).not.toHaveBeenCalled();
    expect(stepPane).not.toHaveBeenCalled();
    expect(sent.every((m) => m.type === "error")).toBe(true);
  });
});

describe("recordings", () => {
  const REC_A = "rec_aaaaaaaaaaaaaaaa";
  const REC_B = "rec_bbbbbbbbbbbbbbbb";

  function row(id: string, over: Record<string, unknown> = {}) {
    return {
      id,
      filename: `${id}.cast`,
      target: { kind: "session", session: "work" },
      title: "work",
      cols: 80,
      rows: 24,
      startedAt: 1000,
      endedAt: 2000,
      bytes: 10,
      events: 1,
      truncated: false,
      stopReason: "requested",
      ...over,
    };
  }

  beforeEach(() => {
    recordingsList.mockResolvedValue([row(REC_A), row(REC_B)]);
    recordingsGet.mockImplementation(async (id: string) =>
      Promise.resolve(id === REC_A || id === REC_B ? row(id) : null),
    );
    recordingsRemove.mockResolvedValue(true);
  });

  it("gives a full grant every recording", async () => {
    await route({ type: "recording:list" });
    const reply = sent.find((m) => m.type === "recording:list");
    expect(reply).toBeDefined();
    expect(
      (reply as { recordings: Array<{ id: string }> }).recordings.map(
        (r) => r.id,
      ),
    ).toEqual([REC_A, REC_B]);
  });

  it("filters the list down to a recordings-scoped grant's own", async () => {
    conn.grant = {
      ...FULL_GRANT,
      id: "grn_rec",
      scope: { kind: "recordings", recordings: [REC_B] },
    };
    await route({ type: "recording:list" });
    const reply = sent.find((m) => m.type === "recording:list");
    expect(
      (reply as { recordings: Array<{ id: string }> }).recordings.map(
        (r) => r.id,
      ),
    ).toEqual([REC_B]);
  });

  it("gives a sessions-scoped grant none", async () => {
    // Sharing a live session was never sharing its history.
    conn.grant = {
      ...FULL_GRANT,
      id: "grn_sess",
      scope: { kind: "sessions", sessions: [{ id: "$1", name: "work" }] },
    };
    await route({ type: "recording:list" });
    const reply = sent.find((m) => m.type === "recording:list");
    expect((reply as { recordings: unknown[] }).recordings).toEqual([]);
  });

  it("answers NOT_FOUND, never ACCESS_DENIED, for a recording out of scope", async () => {
    // Two different answers is an oracle for enumerating recording ids — the
    // same rule `policy.ts` follows for session names.
    conn.grant = {
      ...FULL_GRANT,
      id: "grn_rec",
      scope: { kind: "recordings", recordings: [REC_A] },
    };
    await route({ type: "recording:fetch", id: REC_B, offset: 0 });
    const error = sent.find((m) => m.type === "error");
    expect(error).toMatchObject({ code: "NOT_FOUND" });
    expect(JSON.stringify(sent)).not.toContain("ACCESS_DENIED");
  });

  it("answers NOT_FOUND identically for an id that does not exist", async () => {
    conn.grant = {
      ...FULL_GRANT,
      id: "grn_rec",
      scope: { kind: "recordings", recordings: [REC_A] },
    };
    await route({
      type: "recording:fetch",
      id: "rec_cccccccccccccccc",
      offset: 0,
    });
    expect(sent.find((m) => m.type === "error")).toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("reports a start failure by its own code rather than as a handler error", async () => {
    const { RecordingError } = await import("./recorder.js");
    recorderStart.mockRejectedValueOnce(
      new RecordingError("PANE_ALREADY_PIPED", "That pane already has a pipe."),
    );
    await route({
      type: "recording:start",
      target: { kind: "pane", session: "work", paneId: "%7" },
    });
    expect(sent.find((m) => m.type === "error")).toMatchObject({
      code: "PANE_ALREADY_PIPED",
    });
  });

  it("announces a started recording", async () => {
    recorderStart.mockResolvedValueOnce(row(REC_A, { endedAt: null }));
    await route({
      type: "recording:start",
      target: { kind: "session", session: "work" },
    });
    expect(sent.find((m) => m.type === "recording:started")).toBeDefined();
  });

  it("never lets a recordings-scoped grant delete anything", async () => {
    // ACCESS_DENIED rather than NOT_FOUND here, and that is not an oracle: the
    // allow-list refuses `recording:delete` for this grant kind outright, so
    // the answer is identical for every id, including its own.
    conn.grant = {
      ...FULL_GRANT,
      id: "grn_rec",
      scope: { kind: "recordings", recordings: [REC_A] },
    };
    for (const id of [REC_A, REC_B]) {
      sent = [];
      await route({ type: "recording:delete", id });
      expect(recordingsRemove).not.toHaveBeenCalled();
      expect(sent.find((m) => m.type === "error")).toMatchObject({
        code: "ACCESS_DENIED",
      });
    }
  });

  it("deletes for a full grant", async () => {
    await route({ type: "recording:delete", id: REC_A });
    expect(recordingsRemove).toHaveBeenCalledWith(REC_A);
    expect(sent.find((m) => m.type === "recording:deleted")).toMatchObject({
      id: REC_A,
    });
  });
});
