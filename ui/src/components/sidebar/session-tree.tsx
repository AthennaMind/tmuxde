import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  AppWindow,
  ArrowLeftRight,
  ChevronRight,
  ClipboardCopy,
  Columns2,
  Eye,
  FolderOpen,
  LayoutGrid,
  Loader2,
  Lock,
  Maximize2,
  Minimize2,
  Monitor,
  MoveHorizontal,
  PenLine,
  PlugZap,
  Plus,
  RefreshCw,
  Rows2,
  SquareArrowOutUpRight,
  SquareTerminal,
  Trash2,
} from "lucide-react";
import type { ClientMessage, PaneInfo, SessionInfo, WindowInfo } from "@/protocol";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { getRelayClient, useRelaySubscription } from "@/hooks/use-websocket";
import { isSessionLocked } from "@/lib/lock-store";
import { zoomPane } from "@/lib/pane-zoom";
import { get as getClient } from "@/lib/relay-registry";
import { useMachineStore } from "@/stores/machine-store";
import type { MachineInfo } from "@/protocol/machines";
import { openMachineSession } from "@/lib/workspace-target";
import { requestSessionDetails } from "@/lib/session-target";
import { shortenPath, timeAgo } from "@/lib/tmux-labels";
import { windowPresentation } from "@/lib/session-presentation";
import { paneCellText } from "@/lib/pane-grid-layout";
import {
  liveWindowsOf,
  machineState,
  machineStatusLabel,
  windowFocus,
  windowPanes,
} from "@/components/overview/overview-model";
import { cn } from "@/lib/utils";
import { getTerminalHandle } from "@/components/terminal/terminal-handle";
import { filesDisabled, isReadOnly, useConnectionStore } from "@/stores/connection-store";
import { OVERVIEW_TAB, useMainTabsStore } from "@/stores/main-tabs-store";
import { usePaneStore } from "@/stores/pane-store";
import { useSessionStore } from "@/stores/session-store";
import { useSessionTreeStore, type SessionDetails } from "@/stores/session-tree-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useUiStore } from "@/stores/ui-store";
import { PanelIconButton } from "./panel-header";
import { LAYOUTS } from "./layout-glyph";
import { PaneGrid, type PaneDragEvent, type PaneGridProps } from "./pane-grid";
import { TreeRow, useTreeKeyboard, type TreeAction, type TreeRowModel } from "./tree-row";

/** Busy sessions report activity on every burst of output. */
const ACTIVITY_REFRESH_MS = 3000;

// What a tree of a machine that is not selected reads from the local stores.
// Stable, so a write to those stores does not render it.
const EMPTY_SESSIONS: SessionInfo[] = [];
const EMPTY_DETAILS: Record<string, SessionDetails> = {};
const EMPTY_LOADING: Record<string, boolean> = {};
const EMPTY_WINDOWS: WindowInfo[] = [];
const EMPTY_PANES: PaneInfo[] = [];

/**
 * Grid start, on the window row's index column: row indent 4 + 14, chevron
 * 16, then 4 of gaps.
 */
const GRID_INDENT = 38;

type GridItem = {
  kind: "grid";
  key: string;
  grid: Omit<PaneGridProps, "showIndex" | "tabStopId" | "onFocusPane">;
};
type Item = { kind: "row"; row: TreeRowModel } | GridItem;

/** What a pane drag would do if dropped where the pointer is. */
type DropTarget =
  | { kind: "swap"; paneId: string; index: number }
  | {
      kind: "join";
      windowId: string;
      direction: "h" | "v";
      rowKey: string;
      window: number;
      /** Index of the pane tmux splits, the window's active pane. */
      beside?: number;
    }
  | { kind: "break"; rowKey: string };

type PaneDrag = {
  session: string;
  pane: PaneInfo;
  windowId: string;
  target: DropTarget | null;
  x: number;
  y: number;
};

/** What each window offers a drag, rebuilt every render. */
type DropWindow = {
  session: string;
  index: number;
  label: string;
  panes: PaneInfo[];
  activeId: string | null;
};

type Confirm = {
  title: string;
  description: string;
  action: string;
  run: () => void;
};

/**
 * Desktop session tree: machine, session, window, and a pane grid under
 * every window with more than one pane.
 *
 * Every row and every cell does something. Click selects, double click
 * renames or zooms, hover shows the common actions and the menu holds the
 * rest. A window or pane in another session attaches that session first.
 *
 * `visible` is false while the tree is mounted but not on screen. It keeps
 * its scroll and collapse state, and stops its clock and its requests.
 */
export function SessionTree({
  machine,
  onCreateSession,
  visible = true,
}: {
  machine: MachineInfo;
  onCreateSession: () => void;
  visible?: boolean;
}) {
  const selectedMachine = useMachineStore((s) => s.activeMachine);
  const inventory = useMachineStore((s) => s.inventory[machine.id]);
  const selected = selectedMachine === machine.id;
  const sendClient = () => (selected ? getRelayClient() : getClient(`inventory:${machine.id}`));
  // The local stores hold the selected machine only. Every other tree reads
  // stable empty values from them, so their writes do not render it.
  const localSessions = useSessionStore((s) => (selected ? s.sessions : EMPTY_SESSIONS));
  const localSessionsLoaded = useSessionStore((s) => selected && s.sessionsLoaded);
  const activeSessionId = useSessionStore((s) => (selected ? s.activeSessionId : null));
  const localStatus = useConnectionStore((s) => (selected ? s.status : null));
  const capabilities = useConnectionStore((s) => s.capabilities);
  const attachedSession = useSessionTreeStore((s) => (selected ? s.attachedSession : null));
  const localDetails = useSessionTreeStore((s) => (selected ? s.details : EMPTY_DETAILS));
  const loading = useSessionTreeStore((s) => (selected ? s.loading : EMPTY_LOADING));
  const liveWindows = usePaneStore((s) => (selected ? s.windows : EMPTY_WINDOWS));
  const livePanes = usePaneStore((s) => (selected ? s.panes : EMPTY_PANES));
  const activeWindowId = usePaneStore((s) => (selected ? s.activeWindowId : null));
  const activePaneId = usePaneStore((s) => (selected ? s.activePaneId : null));
  const zoomedPaneId = usePaneStore((s) => (selected ? s.zoomedPaneId : null));
  const pendingKey = usePaneStore((s) => (selected ? s.pendingKey : null));
  // The overview draws the attached session from the same listing, so the
  // selected machine keeps asking while the overview is open.
  const overviewOpen = useMainTabsStore((s) => selected && s.active === OVERVIEW_TAB);
  const asking = visible || overviewOpen;

  const sessions = inventory?.sessions ?? localSessions;
  const sessionsLoaded = !!inventory?.loaded || localSessionsLoaded;
  const status = inventory?.status ?? localStatus ?? "disconnected";
  const details = selected
    ? { ...inventory?.details, ...localDetails }
    : (inventory?.details ?? EMPTY_DETAILS);
  const showPaneIndexes = useSettingsStore((s) => s.showPaneIndexes);

  const askDetails = (name: string, interval = 0) => {
    if (selected) requestSessionDetails(name, interval);
    else sendClient()?.send({ type: "session:windows", name });
  };

  const readOnly = isReadOnly(capabilities);
  const canBrowse = !filesDisabled(capabilities);
  const connected = status === "connected";

  const [expandedSessions, setExpandedSessions] = useState<Set<string>>(
    () => new Set(sessions.map((session) => session.name)),
  );
  // Windows with several panes start open. This holds the ones closed by hand.
  const [collapsedWindows, setCollapsedWindows] = useState<Set<string>>(() => new Set());
  const [collapsed, setCollapsed] = useState(false);
  const bodyId = useId();
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const [menuKey, setMenuKey] = useState<string | null>(null);
  const [renameKey, setRenameKey] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  // Set when the destructive action ran. Its row, and the menu that opened
  // the dialog, are gone by the time the dialog closes.
  const confirmed = useRef(false);
  // Row or cell that had focus when the dialog opened. The dialog has no
  // trigger, so on cancel nothing else would take focus back.
  const confirmReturn = useRef<HTMLElement | null>(null);
  const [, setTick] = useState(0);
  const tree = useTreeKeyboard();
  const sectionRef = useRef<HTMLElement>(null);
  const [paneDrag, setPaneDrag] = useState<PaneDrag | null>(null);
  const chipRef = useRef<HTMLDivElement>(null);
  const dropWindows = useRef(new Map<string, DropWindow>());

  // Relative times read "now", "4m", "2h". A minute tick keeps them honest
  // while they are on screen. Shown again, the tree renders with new times.
  useEffect(() => {
    if (!visible) return;
    const id = setInterval(() => setTick((n) => n + 1), 60_000);
    return () => clearInterval(id);
  }, [visible]);

  // The session you are in is always open.
  useEffect(() => {
    if (!activeSessionId) return;
    setExpandedSessions((prev) =>
      prev.has(activeSessionId) ? prev : new Set(prev).add(activeSessionId),
    );
  }, [activeSessionId]);

  const sessionNames = sessions.map((s) => s.name).join("\n");
  useEffect(() => {
    setExpandedSessions((previous) => {
      const next = new Set(previous);
      for (const session of sessions) {
        if (!details[session.name]) next.add(session.name);
      }
      return next;
    });
  }, [sessionNames]);
  const expandedKey = [...expandedSessions].sort().join("\n");

  // Fetch details for every open session that has none yet.
  useEffect(() => {
    if (!connected || !asking) return;
    const known = new Set(sessionNames.split("\n"));
    const have = details;
    for (const name of expandedKey.split("\n")) {
      if (name && known.has(name) && !have[name]) askDetails(name);
    }
  }, [connected, asking, expandedKey, sessionNames]);

  // Any layout change in the attached session refreshes its full listing.
  // `pane-store` only carries the window on screen.
  const layoutKey = useMemo(
    () =>
      liveWindows.map((w) => `${w.id}:${w.name}:${w.paneCount}:${w.active ? 1 : 0}`).join("|") +
      "#" +
      livePanes.map((p) => `${p.id}:${p.windowId}`).join(","),
    [liveWindows, livePanes],
  );
  useEffect(() => {
    if (!connected || !attachedSession || !asking) return;
    const timer = setTimeout(() => askDetails(attachedSession), 250);
    return () => clearTimeout(timer);
  }, [connected, attachedSession, asking, layoutKey]);

  const expandedRef = useRef(expandedSessions);
  expandedRef.current = expandedSessions;

  // Activity does not refresh a hidden tree. Shown again, every open session
  // of the selected machine asks once, so no listing stays stale.
  const wasAsking = useRef(asking);
  useEffect(() => {
    const resumed = asking && !wasAsking.current;
    wasAsking.current = asking;
    if (!resumed || !connected || !selected) return;
    for (const name of expandedRef.current) askDetails(name, ACTIVITY_REFRESH_MS);
  }, [asking]);

  useRelaySubscription((msg) => {
    if (!selected || !asking) return;
    if (msg.type === "session:activity" && expandedRef.current.has(msg.name)) {
      // Commands and folders change with output, not with layout.
      askDetails(msg.name, ACTIVITY_REFRESH_MS);
    }
  });

  /** Open the target machine before applying pane or window commands. */
  const inSession = useCallback(
    (session: string, messages: ClientMessage[], after?: () => void) => {
      if (!openMachineSession(machine.id, session, messages)) return;
      useMainTabsStore.getState().showTerminal();
      after?.();
    },
    [machine.id],
  );

  const toggleSession = (name: string) =>
    setExpandedSessions((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

  const toggleWindow = (id: string) =>
    setCollapsedWindows((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const split = (session: string, select: ClientMessage, direction: "h" | "v") =>
    inSession(session, [select, { type: "pane:split", direction }]);

  const copyPane = (session: string, id: string) => {
    useMachineStore.setState({
      capture: { machineId: machine.id, paneId: id, expires: Date.now() + 10_000 },
    });
    inSession(session, [{ type: "pane:capture", id }]);
  };

  const browsePane = (session: string, id: string) =>
    inSession(session, [{ type: "pane:select", id }], () =>
      useUiStore.getState().showSidebarView("files"),
    );

  const toggleZoom = (session: string, pane: PaneInfo, live: boolean, zoomed: boolean) => {
    if (live && pane.windowId === activeWindowId) {
      useMainTabsStore.getState().showTerminal();
      zoomPane({ id: pane.id, zoomed: !zoomed });
      return;
    }
    inSession(session, [
      { type: "pane:select", id: pane.id },
      { type: "pane:zoom", id: pane.id, zoomed: !zoomed },
    ]);
  };

  const killPane = (session: string, pane: PaneInfo) =>
    setConfirm({
      title: `Kill pane ${pane.index}?`,
      description:
        "The pane and every process running in it are terminated. This cannot be undone.",
      action: "Kill pane",
      run: () => inSession(session, [{ type: "pane:kill", id: pane.id }]),
    });

  const swap = (session: string, pane: PaneInfo, target: string) =>
    // tmux makes the pane each window received active, which in one window
    // is the target. Focus follows the dragged pane instead.
    inSession(session, [
      { type: "pane:swap", id: pane.id, target },
      { type: "pane:select", id: pane.id },
    ]);
  const join = (session: string, pane: PaneInfo, windowId: string, direction: "h" | "v") =>
    inSession(session, [{ type: "pane:join", id: pane.id, windowId, direction }]);
  const breakOut = (session: string, pane: PaneInfo) =>
    inSession(session, [{ type: "pane:break", id: pane.id }]);
  /** Focus a row of this tree by key, such as `w:@3`. */
  const focusRow = (key: string) =>
    sectionRef.current?.querySelector<HTMLElement>(`[data-tree-row="${CSS.escape(key)}"]`)?.focus();

  /**
   * Drop target under the pointer. A cell of the same window swaps. A window
   * row of the same session joins, beside its active pane on the left half
   * and below it on the right half. The session row and New window break
   * out. tmux refuses a join of a window's active pane into that window and
   * only moves a window for a break of its only pane, so neither is offered.
   */
  const resolveDrop = (
    session: string,
    pane: PaneInfo,
    windowId: string,
    x: number,
    y: number,
  ): DropTarget | null => {
    const element = document.elementFromPoint(x, y);
    if (!element || !sectionRef.current?.contains(element)) return null;
    const own = dropWindows.current.get(windowId);
    const cell = element.closest<HTMLElement>("[data-cell]");
    if (cell) {
      const target = own?.panes.find((other) => other.id === cell.dataset.cell);
      return target && target.id !== pane.id
        ? { kind: "swap", paneId: target.id, index: target.index }
        : null;
    }
    const row = element.closest<HTMLElement>("[data-row-key]");
    const key = row?.dataset.rowKey;
    if (!row || !key) return null;
    if (key === `s:${session}` || key === `new:${session}`) {
      return own && own.panes.length > 1 ? { kind: "break", rowKey: key } : null;
    }
    if (!key.startsWith("w:")) return null;
    const id = key.slice(2);
    const target = dropWindows.current.get(id);
    if (!target || target.session !== session) return null;
    if (id === windowId && target.activeId === pane.id) return null;
    const bounds = row.getBoundingClientRect();
    return {
      kind: "join",
      windowId: id,
      direction: x < bounds.left + bounds.width / 2 ? "h" : "v",
      rowKey: key,
      window: target.index,
      beside: target.panes.find((other) => other.id === target.activeId)?.index,
    };
  };

  const sameTarget = (a: DropTarget | null, b: DropTarget | null) =>
    JSON.stringify(a) === JSON.stringify(b);

  const onPaneDrag = (session: string, windowId: string, event: PaneDragEvent) => {
    if (event.phase === "cancel") {
      setPaneDrag(null);
      return;
    }
    const target = resolveDrop(session, event.pane, windowId, event.x, event.y);
    if (event.phase === "drop") {
      setPaneDrag(null);
      if (target?.kind === "swap") swap(session, event.pane, target.paneId);
      else if (target?.kind === "join")
        join(session, event.pane, target.windowId, target.direction);
      else if (target?.kind === "break") breakOut(session, event.pane);
      return;
    }
    // The chip follows the pointer without a render. The tree renders when
    // the target changes.
    const chip = chipRef.current;
    if (chip) chip.style.transform = chipAt(event.x, event.y);
    setPaneDrag((previous) =>
      previous && previous.pane.id === event.pane.id && sameTarget(previous.target, target)
        ? previous
        : { session, pane: event.pane, windowId, target, x: event.x, y: event.y },
    );
  };

  // Build the visible rows and grids, top to bottom.
  const rows: TreeRowModel[] = [];
  const items: Item[] = [];
  const cellKeys: string[] = [];
  const addRow = (row: TreeRowModel) => {
    rows.push(row);
    items.push({ kind: "row", row });
  };
  let selectedKey: string | null = null;
  const nextDropWindows = new Map<string, DropWindow>();

  for (const session of sessions) {
    const name = session.name;
    const sessionKey = `s:${name}`;
    const isActive = name === activeSessionId;
    const live = name === attachedSession;
    // While a switch attaches, the old session is still the live one. Only
    // the session that is both picked and attached shows a selection.
    const showing = live && isActive;
    const expanded = expandedSessions.has(name);
    const d = details[name];
    // The attached session's windows are announced as they change. Right
    // after a switch they can still be the windows of the session before.
    const ownLive = liveWindowsOf(name, attachedSession, liveWindows, details);
    const windows: WindowInfo[] = ownLive.length ? ownLive : (d?.windows ?? []);
    // The listed count only moves with the next session list.
    const windowCount = ownLive.length || session.windows;
    const serverId = machine.id;
    const locked = !!serverId && isSessionLocked(serverId, name);

    const sessionMenu: TreeAction[] = [
      ...(isActive
        ? []
        : [
            {
              label: "Open",
              icon: SquareTerminal,
              onSelect: () => inSession(name, []),
            },
          ]),
      ...(readOnly
        ? []
        : [
            {
              label: "New window",
              icon: Plus,
              onSelect: () => inSession(name, [{ type: "window:create" }]),
            },
            {
              label: "Rename",
              icon: PenLine,
              shortcut: "F2",
              onSelect: () => setRenameKey(sessionKey),
            },
            {
              label: "Kill session",
              icon: Trash2,
              shortcut: "Del",
              destructive: true,
              separated: true,
              onSelect: () =>
                setConfirm({
                  title: `Kill session "${name}"?`,
                  description:
                    "The session and every process in it are terminated. This cannot be undone.",
                  action: "Kill session",
                  run: () => sendClient()?.send({ type: "session:kill", name }),
                }),
            },
          ]),
    ];

    addRow({
      key: sessionKey,
      parentKey: null,
      depth: 0,
      label: name,
      title: `${name}, ${windowCount} window${windowCount === 1 ? "" : "s"}, active ${timeAgo(session.activity)}`,
      current: isActive,
      expandable: true,
      expanded,
      toggle: () => toggleSession(name),
      activate: () => {
        if (!expanded) toggleSession(name);
        inSession(name, []);
      },
      doubleClick: readOnly ? undefined : () => setRenameKey(sessionKey),
      rename: readOnly
        ? undefined
        : {
            value: name,
            submit: (newName) =>
              sendClient()?.send({
                type: "session:rename",
                oldName: name,
                newName,
              }),
          },
      remove: readOnly ? undefined : sessionMenu.at(-1)?.onSelect,
      meta: (
        <>
          {locked && <Lock className="h-3 w-3" aria-label="Requires unlock" />}
          {!isActive && session.attached && (
            <Monitor className="h-3 w-3" aria-label="Open in another client" />
          )}
          <span className="flex items-center gap-0.5">
            <AppWindow className="h-3 w-3" aria-hidden />
            {windowCount}
          </span>
          <span className="w-6 text-end">{timeAgo(session.activity)}</span>
        </>
      ),
      inline: readOnly
        ? []
        : [
            {
              label: "New window",
              icon: Plus,
              onSelect: () => inSession(name, [{ type: "window:create" }]),
            },
          ],
      menu: sessionMenu,
      drop:
        paneDrag?.target?.kind === "break" && paneDrag.target.rowKey === sessionKey
          ? { kind: "break" }
          : undefined,
    });

    if (!expanded) {
      if (isActive) selectedKey = sessionKey;
      continue;
    }

    if (!windows.length) {
      addRow({
        key: `status:${name}`,
        parentKey: sessionKey,
        depth: 1,
        label: loading[name] || !d ? "Loading windows" : "No windows",
        muted: true,
        activate: () => askDetails(name),
      });
      if (isActive) selectedKey = sessionKey;
      continue;
    }

    // Every window of the session first: a pane menu lists the others, and
    // a drag needs their rows.
    const windowList = windows.map((w) => {
      const panes = windowPanes(w, d?.panes, live ? livePanes : []);
      const onScreen = live && w.id === activeWindowId;
      const focus = windowFocus(w, panes, onScreen ? { activePaneId, zoomedPaneId } : null);
      const presentation = windowPresentation(w.name, panes);
      nextDropWindows.set(w.id, {
        session: name,
        index: w.index,
        label: presentation.label,
        panes,
        activeId: focus.focusId,
      });
      return { w, panes, presentation, ...focus };
    });

    let windowSelected = false;
    for (const { w, panes, focusId, zoomedId, zoomed: windowZoomed, presentation } of windowList) {
      const windowKey = `w:${w.id}`;
      const windowActive = showing && w.id === activeWindowId;
      const paneCount = Math.max(panes.length, w.paneCount);
      const multi = paneCount > 1;
      const windowExpanded = multi && !collapsedWindows.has(w.id);
      const sole = panes.length === 1 ? panes[0] : undefined;
      const selectWindow: ClientMessage = { type: "window:select", id: w.id };
      // A name someone set leads, so the processes follow it. A single pane
      // shows where it is instead of a grid.
      const secondary = multi
        ? presentation.custom
          ? presentation.processes
          : undefined
        : presentation.custom && presentation.processes
          ? [presentation.processes, presentation.folder].filter(Boolean).join(" · ")
          : presentation.folder;

      const layoutActions: TreeAction[] = LAYOUTS.map((layout) => ({
        label: layout.label,
        icon: layout.icon,
        wide: true,
        onSelect: () =>
          inSession(name, [selectWindow, { type: "window:layout", preset: layout.preset }]),
      }));

      const windowMenu: TreeAction[] = [
        ...(windowActive
          ? []
          : [
              {
                label: "Open",
                icon: SquareTerminal,
                onSelect: () => inSession(name, [selectWindow]),
              },
            ]),
        ...(readOnly
          ? []
          : [
              {
                label: "Rename",
                icon: PenLine,
                shortcut: "F2",
                onSelect: () => setRenameKey(windowKey),
              },
              {
                label: "Split right",
                icon: Columns2,
                onSelect: () => split(name, selectWindow, "h"),
              },
              {
                label: "Split down",
                icon: Rows2,
                onSelect: () => split(name, selectWindow, "v"),
              },
              ...(multi
                ? [
                    {
                      label: "Layout",
                      icon: LayoutGrid,
                      onSelect: () => {},
                      submenu: layoutActions,
                    },
                  ]
                : []),
            ]),
        ...(sole
          ? [
              {
                label: "Copy contents",
                icon: ClipboardCopy,
                separated: true,
                onSelect: () => copyPane(name, sole.id),
              },
              ...(canBrowse
                ? [
                    {
                      label: "Browse files here",
                      icon: FolderOpen,
                      onSelect: () => browsePane(name, sole.id),
                    },
                  ]
                : []),
            ]
          : []),
        ...(readOnly
          ? []
          : [
              {
                label: "Kill window",
                icon: Trash2,
                shortcut: "Del",
                destructive: true,
                separated: true,
                onSelect: () =>
                  setConfirm({
                    title: `Kill window ${w.index} "${w.name}"?`,
                    description:
                      "The window, its panes and every process in them are terminated. This cannot be undone.",
                    action: "Kill window",
                    run: () => inSession(name, [{ type: "window:kill", id: w.id }]),
                  }),
              },
            ]),
      ];

      addRow({
        key: windowKey,
        parentKey: sessionKey,
        depth: 1,
        prefix: String(w.index),
        label: presentation.label,
        secondary,
        peek:
          !locked && !multi && sole
            ? { pane: sole, machineId: machine.id, session: name }
            : undefined,
        title: [
          `${w.index}: ${w.name}`,
          presentation.processes,
          sole?.path ? `in ${shortenPath(sole.path)}` : undefined,
          multi ? `${paneCount} panes` : undefined,
          windowZoomed ? "zoomed" : undefined,
        ]
          .filter(Boolean)
          .join(", "),
        current: windowActive,
        pending: pendingKey === w.id,
        expandable: multi,
        expanded: windowExpanded,
        toggle: multi ? () => toggleWindow(w.id) : undefined,
        activate: () => inSession(name, [selectWindow]),
        doubleClick: readOnly ? undefined : () => setRenameKey(windowKey),
        rename: readOnly
          ? undefined
          : {
              value: w.name,
              submit: (newName) =>
                inSession(name, [{ type: "window:rename", id: w.id, name: newName }]),
            },
        remove: readOnly ? undefined : windowMenu.at(-1)?.onSelect,
        meta: (
          <>
            {/* The open grid shows the panes. A narrow tree gives the room to the name. */}
            {multi && (
              <span className={windowExpanded ? "@max-[15.5rem]/tree:hidden" : undefined}>
                {paneCount} panes
              </span>
            )}
            {windowZoomed && <Maximize2 className="h-3 w-3" role="img" aria-label="Zoomed" />}
            {w.activity && !windowActive && (
              <span
                role="img"
                className="h-1.5 w-1.5 rounded-full bg-primary"
                aria-label="New output"
              />
            )}
          </>
        ),
        // Several panes split from their cell edges, so the row offers the
        // layouts. A single pane has no cells, so the row splits it.
        inline: readOnly
          ? []
          : multi
            ? layoutActions
            : [
                {
                  label: "Split right",
                  icon: Columns2,
                  onSelect: () => split(name, selectWindow, "h"),
                },
                {
                  label: "Split down",
                  icon: Rows2,
                  onSelect: () => split(name, selectWindow, "v"),
                },
              ],
        menu: windowMenu,
        drop:
          paneDrag?.target?.kind === "join" && paneDrag.target.rowKey === windowKey
            ? { kind: "join", direction: paneDrag.target.direction }
            : undefined,
      });

      if (!windowExpanded || !panes.length) {
        if (windowActive) {
          selectedKey = windowKey;
          windowSelected = true;
        }
        continue;
      }

      const paneMenu: PaneGridProps["menu"] = (pane, grid) => {
        const paneActive = windowActive && pane.id === focusId;
        const zoomed = pane.id === zoomedId;
        const selectPane: ClientMessage = { type: "pane:select", id: pane.id };
        // Keyboard routes for the drags: swap, join and break.
        const moves: TreeAction[] = readOnly
          ? []
          : [
              ...(panes.length > 1
                ? [
                    {
                      label: "Swap with",
                      icon: ArrowLeftRight,
                      onSelect: () => {},
                      submenu: panes
                        .filter((other) => other.id !== pane.id)
                        .sort((a, b) => a.index - b.index)
                        .map((other) => ({
                          label: `Pane ${other.index}, ${paneCellText(other).label}`,
                          onSelect: () => swap(name, pane, other.id),
                        })),
                    },
                  ]
                : []),
              ...(windowList.length > 1
                ? [
                    {
                      label: "Move to window",
                      icon: AppWindow,
                      onSelect: () => {},
                      submenu: windowList
                        .filter((other) => other.w.id !== w.id)
                        .map((other) => {
                          const beside = other.panes.find((p) => p.id === other.focusId)?.index;
                          const target =
                            beside === undefined ? "the active pane" : `pane ${beside}`;
                          return {
                            label: `${other.w.index} ${other.presentation.label}`,
                            onSelect: () => {},
                            submenu: [
                              {
                                label: `Beside ${target}`,
                                icon: Columns2,
                                onSelect: () => {
                                  join(name, pane, other.w.id, "h");
                                  grid.focusAfter(() => focusRow(`w:${other.w.id}`));
                                },
                              },
                              {
                                label: `Below ${target}`,
                                icon: Rows2,
                                onSelect: () => {
                                  join(name, pane, other.w.id, "v");
                                  grid.focusAfter(() => focusRow(`w:${other.w.id}`));
                                },
                              },
                            ],
                          };
                        }),
                    },
                  ]
                : []),
              ...(panes.length > 1
                ? [
                    {
                      label: "Break out",
                      icon: SquareArrowOutUpRight,
                      // The new window row shows up later. Its session
                      // row holds focus until then.
                      onSelect: () => {
                        breakOut(name, pane);
                        grid.focusAfter(() => focusRow(sessionKey));
                      },
                    },
                  ]
                : []),
            ];
        if (moves[0]) moves[0] = { ...moves[0], separated: true };
        return [
          ...(paneActive
            ? []
            : [
                {
                  label: "Focus",
                  icon: SquareTerminal,
                  onSelect: () => inSession(name, [selectPane]),
                },
              ]),
          ...(grid.peek ? [{ label: "Peek", icon: Eye, shortcut: "P", onSelect: grid.peek }] : []),
          ...(readOnly
            ? []
            : [
                {
                  label: zoomed ? "Unzoom" : "Zoom",
                  icon: zoomed ? Minimize2 : Maximize2,
                  onSelect: () => toggleZoom(name, pane, live, zoomed),
                },
                {
                  label: "Split right",
                  icon: Columns2,
                  onSelect: () => split(name, selectPane, "h"),
                },
                {
                  label: "Split down",
                  icon: Rows2,
                  onSelect: () => split(name, selectPane, "v"),
                },
                ...(grid.resize
                  ? [
                      {
                        label: "Resize",
                        icon: MoveHorizontal,
                        shortcut: "Alt+Arrow",
                        onSelect: grid.resize,
                      },
                    ]
                  : []),
              ]),
          ...moves,
          {
            label: "Copy contents",
            icon: ClipboardCopy,
            separated: true,
            onSelect: () => copyPane(name, pane.id),
          },
          ...(canBrowse
            ? [
                {
                  label: "Browse files here",
                  icon: FolderOpen,
                  onSelect: () => browsePane(name, pane.id),
                },
              ]
            : []),
          ...(readOnly
            ? []
            : [
                {
                  label: "Kill pane",
                  icon: Trash2,
                  shortcut: "Del",
                  destructive: true,
                  separated: true,
                  onSelect: () => killPane(name, pane),
                },
              ]),
        ];
      };

      items.push({
        kind: "grid",
        key: `g:${w.id}`,
        grid: {
          layout: w.layout,
          panes,
          dimensions: w.dimensions,
          focusId,
          zoomedId,
          active: windowActive,
          pendingId: pendingKey,
          label: `Panes of window ${w.index} ${presentation.label}`,
          onSelect: (pane) => inSession(name, [{ type: "pane:select", id: pane.id }]),
          onZoom: readOnly
            ? undefined
            : (pane) => toggleZoom(name, pane, live, pane.id === zoomedId),
          onKill: readOnly ? undefined : (pane) => killPane(name, pane),
          onSplit: readOnly
            ? undefined
            : (pane, direction) => split(name, { type: "pane:select", id: pane.id }, direction),
          // The attached session takes each step of a drag. Any other has to
          // attach first, and attaching keeps one queued batch, so it gets
          // one resize on release.
          onResize: readOnly
            ? undefined
            : (pane, direction, amount) => {
                const message: ClientMessage = {
                  type: "pane:resize",
                  id: pane.id,
                  direction,
                  amount,
                };
                if (live) sendClient()?.send(message);
                else inSession(name, [message]);
              },
          liveResize: live,
          onDrag: readOnly ? undefined : (event) => onPaneDrag(name, w.id, event),
          dropTargetId:
            paneDrag?.windowId === w.id && paneDrag.target?.kind === "swap"
              ? paneDrag.target.paneId
              : null,
          preview: !locked ? { machineId: machine.id, session: name } : undefined,
          menu: paneMenu,
        },
      });
      cellKeys.push(...panes.map((pane) => `p:${pane.id}`));

      if (windowActive) {
        if (focusId && panes.some((pane) => pane.id === focusId)) {
          selectedKey = `p:${focusId}`;
        } else {
          selectedKey = windowKey;
          windowSelected = true;
        }
      }
    }

    if (live && !readOnly) {
      addRow({
        key: `new:${name}`,
        parentKey: sessionKey,
        depth: 1,
        label: "New window",
        icon: <Plus className="h-3.5 w-3.5 shrink-0" aria-hidden />,
        muted: true,
        activate: () => inSession(name, [{ type: "window:create" }]),
        drop:
          paneDrag?.target?.kind === "break" && paneDrag.target.rowKey === `new:${name}`
            ? { kind: "break" }
            : undefined,
      });
    }
    if (isActive && !windowSelected && !selectedKey?.startsWith("p:")) {
      selectedKey = sessionKey;
    }
  }

  dropWindows.current = nextDropWindows;
  for (const row of rows) {
    if (row.key === selectedKey) row.selected = true;
  }

  const focusable = [
    ...rows.filter((r) => !r.key.startsWith("status:")).map((r) => r.key),
    ...cellKeys,
  ];
  const tabStop =
    (focusKey && focusable.includes(focusKey) && focusKey) || selectedKey || focusable[0] || null;

  const unreachable = !sessionsLoaded && (status === "disconnected" || status === "reconnecting");
  // The overview's words for the same states. A socket that dropped is not a
  // machine that is off.
  const machineStatus = machineStatusLabel(
    machineState(machine.online, sessionsLoaded, !!inventory || selected, status),
    connected,
  );

  return (
    <section
      ref={sectionRef}
      aria-label={machine.name}
      className="flex shrink-0 flex-col border-t border-border/60 first:border-t-0"
    >
      <div className="flex min-h-11 items-center gap-2 ps-1.5 pe-3 pt-1">
        <h3 className="flex min-w-0 flex-1 text-xs font-medium text-muted-foreground">
          <button
            type="button"
            aria-expanded={!collapsed}
            aria-controls={bodyId}
            title={[
              machine.name,
              machine.hostname !== machine.name ? machine.hostname : undefined,
              sessionsLoaded
                ? `${sessions.length} session${sessions.length === 1 ? "" : "s"}`
                : undefined,
            ]
              .filter(Boolean)
              .join(", ")}
            onClick={() => setCollapsed((value) => !value)}
            className="flex h-8 min-w-0 max-w-full items-center gap-1.5 rounded-md ps-1 pe-1.5 text-start transition-colors hover:bg-accent/50 hover:text-foreground"
          >
            <span className="flex w-4 shrink-0 justify-center">
              <ChevronRight
                aria-hidden
                className={cn(
                  "h-3.5 w-3.5 transition-[rotate] duration-150",
                  !collapsed && "rotate-90",
                )}
              />
            </span>
            {/*
              One line that wraps into a clipped second line. The name comes
              first and truncates only once it has the line alone. The Local
              tag and the count wrap away before that, and stay in the title
              and for screen readers.
            */}
            <span className="flex h-4 min-w-0 flex-1 flex-wrap items-center gap-x-1.5 overflow-hidden leading-4">
              <span className="min-w-0 max-w-full truncate">{machine.name}</span>
              {machine.id === "local" && (
                <span className="rounded bg-muted px-1 text-[11px] font-normal leading-4">
                  Local
                </span>
              )}
              {sessionsLoaded && (
                // Icon and count, like the window count of a session row. A
                // bare number read as part of the name: "Dev Beta 1".
                <span className="flex items-center gap-0.5 font-normal tabular-nums">
                  <SquareTerminal className="h-3 w-3" aria-hidden />
                  {sessions.length}
                  <span className="sr-only">
                    {sessions.length === 1 ? " session" : " sessions"}
                  </span>
                </span>
              )}
            </span>
          </button>
        </h3>
        <span
          className="flex items-center gap-1.5 text-[11px] text-muted-foreground"
          title={machineStatus}
        >
          <span
            className={`h-1.5 w-1.5 rounded-full ${machineStatus === "Online" ? "bg-primary" : "bg-muted-foreground/50"}`}
            aria-hidden
          />
          {machineStatus === "Online" ? <span className="sr-only">Online</span> : machineStatus}
        </span>
        {!readOnly && (
          <PanelIconButton
            label="New session"
            icon={Plus}
            onClick={onCreateSession}
            disabled={!connected}
          />
        )}
      </div>

      <div id={bodyId} hidden={collapsed} className="px-1.5 pb-3">
        {unreachable ? (
          <div className="flex flex-col items-start gap-3 px-2 py-6">
            <PlugZap className="h-5 w-5 text-muted-foreground" aria-hidden />
            <div>
              <p className="text-sm font-medium">Can&apos;t reach this machine</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Sessions keep running in tmux while the connection is down.
              </p>
            </div>
            <Button size="sm" variant="outline" onClick={() => sendClient()?.connect()}>
              <RefreshCw className="me-1 h-3.5 w-3.5" aria-hidden />
              Try again
            </Button>
          </div>
        ) : !sessionsLoaded ? (
          <div
            className="flex items-center gap-2 px-2 py-3 text-sm text-muted-foreground"
            role="status"
          >
            <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden />
            Loading sessions
          </div>
        ) : sessions.length === 0 ? (
          <div className="flex flex-col items-start gap-3 px-2 py-6">
            <SquareTerminal className="h-5 w-5 text-muted-foreground" aria-hidden />
            <div>
              <p className="text-sm font-medium">No sessions yet</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Create one to start a shell on this machine.
              </p>
            </div>
            {!readOnly && (
              <Button size="sm" onClick={onCreateSession} disabled={!connected}>
                <Plus className="me-1 h-3.5 w-3.5" aria-hidden />
                New session
              </Button>
            )}
          </div>
        ) : (
          <div
            ref={tree.ref}
            data-tree
            role="group"
            aria-label="Sessions, windows and panes"
            onKeyDown={tree.onKeyDown}
            className="@container/tree space-y-px"
          >
            {items.map((item) => {
              if (item.kind === "grid") {
                const stop =
                  tabStop?.startsWith("p:") &&
                  item.grid.panes.some((pane) => `p:${pane.id}` === tabStop)
                    ? tabStop.slice(2)
                    : null;
                return (
                  <div
                    key={item.key}
                    className="pt-0.5 pb-1.5 pe-1"
                    style={{ paddingInlineStart: GRID_INDENT }}
                  >
                    <PaneGrid
                      {...item.grid}
                      showIndex={showPaneIndexes}
                      tabStopId={stop}
                      onFocusPane={(pane) => setFocusKey(`p:${pane.id}`)}
                    />
                  </div>
                );
              }
              const row = item.row;
              return row.key.startsWith("status:") ? (
                <div
                  key={row.key}
                  className="flex h-7 items-center text-xs text-muted-foreground"
                  style={{ paddingInlineStart: 4 + row.depth * 14 + 22 }}
                >
                  {row.label}
                </div>
              ) : (
                <TreeRow
                  key={row.key}
                  row={row}
                  tabStop={row.key === tabStop}
                  onFocusRow={setFocusKey}
                  menuOpen={menuKey === row.key}
                  onMenuOpenChange={(open) => setMenuKey(open ? row.key : null)}
                  renaming={renameKey === row.key}
                  onRenameStart={() => setRenameKey(row.key)}
                  onRenameEnd={() => setRenameKey(null)}
                />
              );
            })}
          </div>
        )}
      </div>

      <AlertDialog
        open={confirm !== null}
        onOpenChange={(open) => {
          if (!open) setConfirm(null);
        }}
      >
        <AlertDialogContent
          onOpenAutoFocus={() => {
            const previous = document.activeElement;
            confirmReturn.current = previous instanceof HTMLElement ? previous : null;
          }}
          onCloseAutoFocus={(event) => {
            const previous = confirmReturn.current;
            confirmReturn.current = null;
            if (!confirmed.current) {
              if (previous?.isConnected) {
                event.preventDefault();
                previous.focus();
              }
              return;
            }
            confirmed.current = false;
            // Focus went back to a menu item that no longer exists, which
            // leaves it on the page body, and typing went nowhere. The
            // terminal is where the next keystroke belongs.
            event.preventDefault();
            getTerminalHandle()?.focus();
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>{confirm?.title}</AlertDialogTitle>
            <AlertDialogDescription>{confirm?.description}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                confirmed.current = true;
                confirm?.run();
              }}
            >
              {confirm?.action}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {paneDrag &&
        createPortal(
          <div
            ref={chipRef}
            aria-hidden
            className="pointer-events-none fixed left-0 top-0 z-[var(--z-modal)] flex max-w-72 items-center gap-1.5 rounded-md border bg-popover px-2 py-1 font-chrome text-xs leading-4 text-popover-foreground shadow-[var(--shadow-float)]"
            style={{ transform: chipAt(paneDrag.x, paneDrag.y) }}
          >
            <DropChip drag={paneDrag} />
          </div>,
          document.body,
        )}
    </section>
  );
}

/** The drag chip sits below and after the pointer, clear of the drop target. */
function chipAt(x: number, y: number) {
  return `translate(${Math.round(x + 14)}px, ${Math.round(y + 16)}px)`;
}

/** What letting go does, in the drag chip. The dragged cell is dimmed, so the chip names the target. */
function DropChip({ drag }: { drag: PaneDrag }) {
  const target = drag.target;
  if (!target) {
    return (
      <span className="min-w-0 truncate text-muted-foreground">
        Drop on a pane, a window or the session
      </span>
    );
  }
  const [Icon, text] =
    target.kind === "swap"
      ? [ArrowLeftRight, `Swap with pane ${target.index}`]
      : target.kind === "break"
        ? [SquareArrowOutUpRight, "Break out to a new window"]
        : [
            target.direction === "h" ? Columns2 : Rows2,
            `Move ${target.direction === "h" ? "beside" : "below"} ${
              target.beside === undefined ? "the active pane" : `pane ${target.beside}`
            } of window ${target.window}`,
          ];
  return (
    <>
      <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />
      <span className="min-w-0 truncate">{text}</span>
    </>
  );
}
