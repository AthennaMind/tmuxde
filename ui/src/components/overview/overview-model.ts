import type { ConnectionState, PaneInfo, SessionInfo, WindowInfo } from "@/protocol";
import type { MachineInfo } from "@/protocol/machines";
import type { MachineSessions } from "@/stores/machine-store";
import type { SessionDetails } from "@/stores/session-tree-store";
import { processPresentation, windowPresentation } from "@/lib/session-presentation";
import { shortenPath, timeAgo } from "@/lib/tmux-labels";

/**
 * What the overview draws: machines, their sessions and every window.
 *
 * Pure, so the merge of live and listed data and the filter are tested
 * without a DOM. The session tree uses the same live rules: `liveWindowsOf`,
 * `windowPanes` and `windowFocus`.
 */

/** Live state of the machine the terminal is attached to. */
export interface LiveState {
  machineId: string;
  sessions: SessionInfo[];
  sessionsLoaded: boolean;
  status: ConnectionState;
  activeSessionId: string | null;
  attachedSession: string | null;
  details: Record<string, SessionDetails>;
  windows: WindowInfo[];
  panes: PaneInfo[];
  activeWindowId: string | null;
  activePaneId: string | null;
  zoomedPaneId: string | null;
  pendingKey: string | null;
}

export interface OverviewWindow {
  window: WindowInfo;
  panes: PaneInfo[];
  /** Custom name, else the processes, else "Terminal". */
  label: string;
  /** Second line: processes after a custom name, then the folder. */
  detail?: string;
  focusId: string | null;
  zoomedId: string | null;
  zoomed: boolean;
  /** The window the terminal shows now. Its focused pane takes your keys. */
  showing: boolean;
  pendingId: string | null;
}

export interface OverviewSession {
  session: SessionInfo;
  windows: OverviewWindow[];
  /** Windows before the filter. */
  windowCount: number;
  /** Windows not listed yet. */
  loading: boolean;
}

/**
 * - `ready`: sessions listed.
 * - `loading`: connected or connecting, no list yet.
 * - `unreachable`: the hub knows the machine, the socket to it is down.
 * - `offline`: the machine is not connected to the hub.
 */
export type MachineState = "ready" | "loading" | "unreachable" | "offline";

export interface OverviewMachine {
  machine: MachineInfo;
  state: MachineState;
  /** Online and the socket to it is up. */
  connected: boolean;
  status: ConnectionState;
  sessions: OverviewSession[];
  /** Sessions before the filter. */
  sessionCount: number;
}

/**
 * State of a machine from what the hub and its socket said. `reported` is
 * false right after the machine list lands, before any socket answered:
 * that is loading, not a machine that cannot be reached.
 */
export function machineState(
  online: boolean,
  loaded: boolean,
  reported: boolean,
  status: ConnectionState,
): MachineState {
  if (!online) return "offline";
  if (loaded) return "ready";
  return reported && (status === "disconnected" || status === "reconnecting")
    ? "unreachable"
    : "loading";
}

/**
 * The word for a machine's state, in the overview and in the session tree.
 * A loaded machine whose socket dropped is reconnecting, not offline.
 */
export function machineStatusLabel(state: MachineState, connected: boolean): string {
  switch (state) {
    case "ready":
      return connected ? "Online" : "Reconnecting";
    case "loading":
      return "Connecting";
    case "unreachable":
      return "Unreachable";
    case "offline":
      return "Offline";
  }
}

/** Panes of one window. Live panes win in the attached session. */
export function windowPanes(
  window: WindowInfo,
  listed: PaneInfo[] | undefined,
  live: PaneInfo[],
): PaneInfo[] {
  const own = listed?.filter((pane) => pane.windowId === window.id) ?? [];
  // A window switch lands as `window:changed` before `pane:changed`. Matching
  // by window id keeps the old window's live panes out of the new one.
  const current = live.filter((pane) => pane.windowId === window.id);
  if (!current.length) return own;
  // Live panes carry structure, focus and folder. Listed panes are refreshed
  // on activity, so they carry the newer command.
  const byId = new Map(own.map((pane) => [pane.id, pane]));
  return current.map((pane) => {
    const fresh = byId.get(pane.id);
    return fresh ? { ...pane, command: fresh.command } : pane;
  });
}

/**
 * Live windows of `session`, or none.
 *
 * The pane store announces the windows of the attached session. Right after
 * an attach switch it still holds the windows of the session attached
 * before, until the next `window:changed`. A live window that the listing of
 * another session has marks that state. The session then shows its own
 * listing, so no window of another session is drawn or selected under it.
 */
export function liveWindowsOf(
  session: string,
  attachedSession: string | null,
  live: WindowInfo[],
  details: Record<string, SessionDetails | undefined>,
): WindowInfo[] {
  if (session !== attachedSession || !live.length) return [];
  const ids = new Set(live.map((window) => window.id));
  for (const [owner, listing] of Object.entries(details)) {
    if (owner === session) continue;
    if (listing?.windows.some((window) => ids.has(window.id))) return [];
  }
  return live;
}

/** Active and zoomed pane of one window. */
export interface WindowFocus {
  focusId: string | null;
  zoomedId: string | null;
  zoomed: boolean;
}

/**
 * Focus and zoom of one window.
 *
 * The window on screen reads them from the pane store, which moves first.
 * `onScreen` carries its active and zoomed pane, and is null for every other
 * window. Those read the listing.
 */
export function windowFocus(
  window: WindowInfo,
  panes: PaneInfo[],
  onScreen: { activePaneId: string | null; zoomedPaneId: string | null } | null,
): WindowFocus {
  if (onScreen) {
    return {
      focusId: onScreen.activePaneId,
      zoomedId: onScreen.zoomedPaneId,
      zoomed: !!onScreen.zoomedPaneId,
    };
  }
  const focusId = panes.find((pane) => pane.active)?.id ?? null;
  const zoomed = window.zoomed ?? panes.some((pane) => pane.zoomed);
  return {
    focusId,
    zoomedId: zoomed ? (panes.find((pane) => pane.zoomed)?.id ?? focusId) : null,
    zoomed,
  };
}

/** One machine as the overview shows it, before the filter. */
export function buildMachine(
  machine: MachineInfo,
  inventory: MachineSessions | undefined,
  live: LiveState | null,
): OverviewMachine {
  const selected = live?.machineId === machine.id ? live : null;
  const sessions = inventory?.sessions ?? selected?.sessions ?? [];
  const loaded = !!inventory?.loaded || !!selected?.sessionsLoaded;
  const status = inventory?.status ?? selected?.status ?? "disconnected";
  // Inventory keeps refreshing every session. Only the attached session has
  // fresher live details; cached details from earlier attachments can be stale.
  const details = { ...selected?.details, ...inventory?.details };
  const attached = selected?.attachedSession;
  const attachedDetails = attached ? selected?.details[attached] : undefined;
  if (attached && attachedDetails) details[attached] = attachedDetails;

  const state = machineState(machine.online, loaded, !!inventory || !!selected, status);

  return {
    machine,
    state,
    connected: machine.online && status === "connected",
    status,
    sessionCount: state === "ready" ? sessions.length : 0,
    sessions:
      state === "ready" ? sessions.map((session) => buildSession(session, details, selected)) : [],
  };
}

function buildSession(
  session: SessionInfo,
  details: Record<string, SessionDetails | undefined>,
  live: LiveState | null,
): OverviewSession {
  const listed = details[session.name];
  const attached = !!live && live.attachedSession === session.name;
  // While a switch attaches, the old session is still the attached one. Only
  // the session that is both picked and attached is on screen.
  const onScreen = attached && live.activeSessionId === session.name;
  const liveWindows = attached
    ? liveWindowsOf(session.name, live.attachedSession, live.windows, details)
    : [];
  const windows = liveWindows.length ? liveWindows : (listed?.windows ?? []);

  return {
    session,
    loading: !listed && !liveWindows.length,
    // The attached session's windows are announced as they change. The listed
    // count only moves with the next session list.
    windowCount: liveWindows.length || (listed ? windows.length : session.windows),
    windows: windows.map((window) => {
      const panes = windowPanes(window, listed?.panes, attached ? live.panes : []);
      const presentation = windowPresentation(window.name, panes);
      const current = attached && window.id === live.activeWindowId;
      const focus = windowFocus(window, panes, current ? live : null);
      return {
        window,
        panes,
        label: presentation.label,
        detail:
          [presentation.custom ? presentation.processes : undefined, presentation.folder]
            .filter(Boolean)
            .join(" · ") || undefined,
        ...focus,
        showing: onScreen && window.id === live.activeWindowId,
        pendingId: attached ? live.pendingKey : null,
      };
    }),
  };
}

/** Trimmed and lower case. Empty means no filter. */
export function normalizeQuery(query: string): string {
  return query.trim().toLowerCase();
}

function has(text: string | undefined, query: string): boolean {
  return !!text && text.toLowerCase().includes(query);
}

/** Window name, process label or command, or folder of any pane. */
export function windowMatches(window: OverviewWindow, query: string): boolean {
  if (has(window.window.name, query) || has(window.label, query)) return true;
  return window.panes.some(
    (pane) =>
      has(processPresentation(pane.command).label, query) ||
      has(pane.command, query) ||
      has(pane.path, query) ||
      (!!pane.path && has(shortenPath(pane.path), query)),
  );
}

export interface FilteredOverview {
  machines: OverviewMachine[];
  /** Windows shown. */
  windows: number;
  /** First window shown, for Enter in the filter. */
  first: { machine: OverviewMachine; session: OverviewSession; window: OverviewWindow } | null;
}

/**
 * Keep what matches `query`, case insensitive.
 *
 * A session whose name matches keeps every window. Otherwise a session keeps
 * the windows that match by name, process or folder, and goes when none do.
 * A machine with nothing left goes too. No query keeps everything.
 */
export function filterOverview(machines: OverviewMachine[], rawQuery: string): FilteredOverview {
  const query = normalizeQuery(rawQuery);
  const kept = query
    ? machines.flatMap((machine) => {
        const sessions = machine.sessions.flatMap((session) => {
          if (has(session.session.name, query)) return [session];
          const windows = session.windows.filter((window) => windowMatches(window, query));
          return windows.length ? [{ ...session, windows }] : [];
        });
        return sessions.length ? [{ ...machine, sessions }] : [];
      })
    : machines;

  let windows = 0;
  let first: FilteredOverview["first"] = null;
  for (const machine of kept) {
    for (const session of machine.sessions) {
      windows += session.windows.length;
      const window = session.windows[0];
      if (!first && window && machine.connected) first = { machine, session, window };
    }
  }
  return { machines: kept, windows, first };
}

export function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** "active now", "active 4m ago". */
export function activityLabel(activity: string): string {
  const ago = timeAgo(activity);
  return ago === "now" ? "active now" : `active ${ago} ago`;
}

/** Accessible name of a card header, such as "Window 0 top, 4 panes, zoomed". */
export function windowCardName(window: OverviewWindow): string {
  const count = Math.max(window.panes.length, window.window.paneCount);
  return [
    `Window ${window.window.index} ${window.label}`,
    window.detail,
    count > 1 ? plural(count, "pane") : undefined,
    window.zoomed ? "zoomed" : undefined,
    window.window.activity && !window.showing ? "new output" : undefined,
    window.showing ? "on screen" : undefined,
  ]
    .filter(Boolean)
    .join(", ");
}

/** Each pane has its own gallery card, with its full navigation context. */
export interface OverviewPane {
  key: string;
  machine: OverviewMachine;
  session: OverviewSession;
  window: OverviewWindow;
  pane: PaneInfo;
}

export function overviewPanes(machines: OverviewMachine[], rawQuery = ""): OverviewPane[] {
  const query = normalizeQuery(rawQuery);
  return machines.flatMap((machine) =>
    machine.sessions.flatMap((session) =>
      session.windows.flatMap((window) =>
        window.panes.flatMap((pane) => {
          const matches =
            !query ||
            [
              machine.machine.name,
              machine.machine.hostname,
              session.session.name,
              window.window.name,
              pane.command,
              pane.path,
              processPresentation(pane.command).label,
              pane.path && shortenPath(pane.path),
            ].some((value) => has(value, query));
          return matches
            ? [
                {
                  key: JSON.stringify([machine.machine.id, session.session.name, pane.id]),
                  machine,
                  session,
                  window,
                  pane,
                },
              ]
            : [];
        }),
      ),
    ),
  );
}
