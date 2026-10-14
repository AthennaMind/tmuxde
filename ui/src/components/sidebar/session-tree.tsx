import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AppWindow,
  ClipboardCopy,
  Columns2,
  FolderOpen,
  LayoutGrid,
  Loader2,
  Lock,
  Maximize2,
  Minimize2,
  Monitor,
  PenLine,
  PlugZap,
  Plus,
  RefreshCw,
  Rows2,
  SquareTerminal,
  Trash2,
} from "lucide-react";
import type { ClientMessage, PaneInfo, WindowInfo } from "@repo/protocol";
import { Button } from "@repo/ui/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@repo/ui/components/ui/alert-dialog";
import { getRelayClient, useRelaySubscription } from "@/hooks/use-websocket";
import { copyFailureReason, copyText } from "@/lib/clipboard";
import { isSessionLocked } from "@/lib/lock-store";
import { zoomPane } from "@/lib/pane-zoom";
import { getActiveServerId } from "@/lib/relay-registry";
import { requestSessionDetails, runInSession } from "@/lib/session-target";
import { isShellCommand, tailPath, timeAgo } from "@/lib/tmux-labels";
import { RequireUnlockDialog } from "@/components/lock/require-unlock-dialog";
import { getTerminalHandle } from "@/components/terminal/terminal-handle";
import { useAlertStore } from "@/stores/alert-store";
import {
  filesDisabled,
  isReadOnly,
  useConnectionStore,
} from "@/stores/connection-store";
import { useMainTabsStore } from "@/stores/main-tabs-store";
import { usePaneStore } from "@/stores/pane-store";
import { useSessionStore } from "@/stores/session-store";
import { useSessionTreeStore } from "@/stores/session-tree-store";
import { useUiStore } from "@/stores/ui-store";
import { PanelHeader, PanelIconButton } from "./panel-header";
import {
  TreeRow,
  useTreeKeyboard,
  type TreeAction,
  type TreeRowModel,
} from "./tree-row";

/** Busy sessions report activity on every burst of output. */
const ACTIVITY_REFRESH_MS = 3000;

const LAYOUTS = [
  { preset: "even-horizontal", label: "Side by side" },
  { preset: "even-vertical", label: "Stacked" },
  { preset: "main-vertical", label: "Main on left" },
  { preset: "main-horizontal", label: "Main on top" },
  { preset: "tiled", label: "Tiled" },
] as const;

type Confirm = {
  title: string;
  description: string;
  action: string;
  run: () => void;
};

/** Pane text for a row: command when it is not a shell, then its folder. */
function paneText(pane: PaneInfo, windowName?: string) {
  const command =
    !isShellCommand(pane.command) && pane.command !== windowName
      ? pane.command
      : undefined;
  const path = pane.path ? tailPath(pane.path) : undefined;
  return [command, path].filter(Boolean).join(" · ") || undefined;
}

/**
 * Desktop session tree: session, window, pane.
 *
 * Every row does something. Click selects, double click renames or zooms,
 * hover shows the common actions and the menu holds the rest. A window or
 * pane in another session attaches that session first.
 */
export function SessionTree({ onCreateSession }: { onCreateSession: () => void }) {
  const sessions = useSessionStore((s) => s.sessions);
  const sessionsLoaded = useSessionStore((s) => s.sessionsLoaded);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const status = useConnectionStore((s) => s.status);
  const capabilities = useConnectionStore((s) => s.capabilities);
  const attachedSession = useSessionTreeStore((s) => s.attachedSession);
  const details = useSessionTreeStore((s) => s.details);
  const loading = useSessionTreeStore((s) => s.loading);
  const liveWindows = usePaneStore((s) => s.windows);
  const livePanes = usePaneStore((s) => s.panes);
  const activeWindowId = usePaneStore((s) => s.activeWindowId);
  const activePaneId = usePaneStore((s) => s.activePaneId);
  const zoomedPaneId = usePaneStore((s) => s.zoomedPaneId);
  const pendingKey = usePaneStore((s) => s.pendingKey);

  const readOnly = isReadOnly(capabilities);
  const canBrowse = !filesDisabled(capabilities);
  const connected = status === "connected";

  const [expandedSessions, setExpandedSessions] = useState<Set<string>>(
    () => new Set(activeSessionId ? [activeSessionId] : []),
  );
  // Windows with several panes start open. This holds the ones closed by hand.
  const [collapsedWindows, setCollapsedWindows] = useState<Set<string>>(
    () => new Set(),
  );
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const [menuKey, setMenuKey] = useState<string | null>(null);
  const [renameKey, setRenameKey] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  // Set when the destructive action ran. Its row, and the menu that opened
  // the dialog, are gone by the time the dialog closes.
  const confirmed = useRef(false);
  const [challenge, setChallenge] = useState<{
    session: string;
    run: () => void;
  } | null>(null);
  const [, setTick] = useState(0);
  const copyRequest = useRef<string | null>(null);
  const tree = useTreeKeyboard();

  // Relative times read "now", "4m", "2h". A minute tick keeps them honest.
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 60_000);
    return () => clearInterval(id);
  }, []);

  // The session you are in is always open.
  useEffect(() => {
    if (!activeSessionId) return;
    setExpandedSessions((prev) =>
      prev.has(activeSessionId) ? prev : new Set(prev).add(activeSessionId),
    );
  }, [activeSessionId]);

  const sessionNames = sessions.map((s) => s.name).join("\n");
  const expandedKey = [...expandedSessions].sort().join("\n");

  // Fetch details for every open session that has none yet.
  useEffect(() => {
    if (!connected) return;
    const known = new Set(sessionNames.split("\n"));
    const { details: have } = useSessionTreeStore.getState();
    for (const name of expandedKey.split("\n")) {
      if (name && known.has(name) && !have[name]) requestSessionDetails(name);
    }
  }, [connected, expandedKey, sessionNames]);

  // Any layout change in the attached session refreshes its full listing.
  // `pane-store` only carries the window on screen.
  const layoutKey = useMemo(
    () =>
      liveWindows
        .map((w) => `${w.id}:${w.name}:${w.paneCount}:${w.active ? 1 : 0}`)
        .join("|") +
      "#" +
      livePanes.map((p) => `${p.id}:${p.windowId}`).join(","),
    [liveWindows, livePanes],
  );
  useEffect(() => {
    if (!connected || !attachedSession) return;
    const timer = setTimeout(() => requestSessionDetails(attachedSession), 250);
    return () => clearTimeout(timer);
  }, [connected, attachedSession, layoutKey]);

  const expandedRef = useRef(expandedSessions);
  expandedRef.current = expandedSessions;
  useRelaySubscription((msg) => {
    if (msg.type === "session:activity" && expandedRef.current.has(msg.name)) {
      // Commands and folders change with output, not with layout.
      requestSessionDetails(msg.name, ACTIVITY_REFRESH_MS);
    } else if (
      msg.type === "pane:captured" &&
      msg.id === copyRequest.current
    ) {
      copyRequest.current = null;
      void copyText(msg.content).then((ok) =>
        useAlertStore
          .getState()
          .push(
            ok ? "success" : "error",
            ok ? "Copied pane contents" : copyFailureReason(),
          ),
      );
      // The capture also lands in the copy mode slot. Clear it after the
      // websocket handler wrote it, unless copy mode is open and wants it.
      setTimeout(() => {
        const ui = useUiStore.getState();
        if (!ui.copyModeOpen) ui.setCapturedPane(null, null);
      }, 0);
    }
  });

  /** A session marked "require unlock" asks for the PIN before it opens. */
  const guard = useCallback((session: string, run: () => void) => {
    const serverId = getActiveServerId();
    if (
      useSessionTreeStore.getState().attachedSession !== session &&
      serverId &&
      isSessionLocked(serverId, session)
    ) {
      setChallenge({ session, run });
      return;
    }
    run();
  }, []);

  /** Run commands in a session, attaching it first when needed. */
  const inSession = useCallback(
    (session: string, messages: ClientMessage[], after?: () => void) => {
      guard(session, () => {
        if (!runInSession(session, messages)) return;
        useMainTabsStore.getState().showTerminal();
        after?.();
      });
    },
    [guard],
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
    copyRequest.current = id;
    inSession(session, [{ type: "pane:capture", id }]);
  };

  const browsePane = (session: string, id: string) =>
    inSession(session, [{ type: "pane:select", id }], () =>
      useUiStore.getState().showSidebarView("files"),
    );

  const toggleZoom = (
    session: string,
    pane: PaneInfo,
    live: boolean,
    zoomed: boolean,
  ) => {
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

  // Build the visible rows, top to bottom.
  const rows: TreeRowModel[] = [];
  let selectedKey: string | null = null;

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
    const windows: WindowInfo[] =
      live && liveWindows.length ? liveWindows : (d?.windows ?? []);
    // The attached session's windows are announced as they change. The
    // listed count only moves with the next session list.
    const windowCount =
      live && liveWindows.length ? liveWindows.length : session.windows;
    const serverId = getActiveServerId();
    const locked = !!serverId && isSessionLocked(serverId, name);

    const panesOf = (w: WindowInfo): PaneInfo[] => {
      const listed = d?.panes.filter((p) => p.windowId === w.id) ?? [];
      // A window switch lands as `window:changed` before `pane:changed`.
      // In between, live panes still belong to the previous window. Matching
      // by window id keeps them from being drawn under the new one.
      const own = live ? livePanes.filter((p) => p.windowId === w.id) : [];
      if (own.length) {
        // Live panes for structure, focus and folder. The relay announces a
        // folder change within a second. Listed panes are refreshed on
        // activity, so they carry the newer command.
        const byId = new Map(listed.map((p) => [p.id, p]));
        return own.map((p) => {
          const fresh = byId.get(p.id);
          return fresh ? { ...p, command: fresh.command } : p;
        });
      }
      return listed;
    };

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
              onSelect: () => setRenameKey(sessionKey),
            },
            {
              label: "Kill session",
              icon: Trash2,
              destructive: true,
              separated: true,
              onSelect: () =>
                setConfirm({
                  title: `Kill session "${name}"?`,
                  description:
                    "The session and every process in it are terminated. This cannot be undone.",
                  action: "Kill session",
                  run: () =>
                    getRelayClient()?.send({ type: "session:kill", name }),
                }),
            },
          ]),
    ];

    rows.push({
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
              getRelayClient()?.send({
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
            <Monitor
              className="h-3 w-3"
              aria-label="Open in another client"
            />
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
    });

    if (!expanded) {
      if (isActive) selectedKey = sessionKey;
      continue;
    }

    if (!windows.length) {
      rows.push({
        key: `status:${name}`,
        parentKey: sessionKey,
        depth: 1,
        label: loading[name] || !d ? "Loading windows" : "No windows",
        muted: true,
        activate: () => requestSessionDetails(name),
      });
      if (isActive) selectedKey = sessionKey;
      continue;
    }

    let windowSelected = false;
    for (const w of windows) {
      const windowKey = `w:${w.id}`;
      const windowActive = showing && w.id === activeWindowId;
      const panes = panesOf(w);
      const paneCount = Math.max(panes.length, w.paneCount);
      const multi = paneCount > 1;
      const windowExpanded = multi && !collapsedWindows.has(w.id);
      const sole = panes.length === 1 ? panes[0] : undefined;
      const selectWindow: ClientMessage = { type: "window:select", id: w.id };

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
                      submenu: LAYOUTS.map((layout) => ({
                        label: layout.label,
                        onSelect: () =>
                          inSession(name, [
                            selectWindow,
                            { type: "window:layout", preset: layout.preset },
                          ]),
                      })),
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
                destructive: true,
                separated: true,
                onSelect: () =>
                  setConfirm({
                    title: `Kill window ${w.index} "${w.name}"?`,
                    description:
                      "The window, its panes and every process in them are terminated. This cannot be undone.",
                    action: "Kill window",
                    run: () =>
                      inSession(name, [{ type: "window:kill", id: w.id }]),
                  }),
              },
            ]),
      ];

      rows.push({
        key: windowKey,
        parentKey: sessionKey,
        depth: 1,
        prefix: String(w.index),
        label: w.name,
        secondary: sole ? paneText(sole, w.name) : undefined,
        title: sole
          ? `${w.index}: ${w.name}${sole.path ? ` in ${sole.path}` : ""}`
          : `${w.index}: ${w.name}, ${paneCount} panes`,
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
                inSession(name, [
                  { type: "window:rename", id: w.id, name: newName },
                ]),
            },
        remove: readOnly ? undefined : windowMenu.at(-1)?.onSelect,
        meta: (
          <>
            {w.zoomed && <Maximize2 className="h-3 w-3" aria-label="Zoomed" />}
            {w.activity && !windowActive && (
              <span
                className="h-1.5 w-1.5 rounded-full bg-primary"
                aria-label="New output"
              />
            )}
            {multi && (
              <span className="flex items-center gap-0.5" aria-label={`${paneCount} panes`}>
                <LayoutGrid className="h-3 w-3" aria-hidden />
                {paneCount}
              </span>
            )}
          </>
        ),
        inline: readOnly
          ? []
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
      });

      if (!windowExpanded) {
        if (windowActive) {
          selectedKey = windowKey;
          windowSelected = true;
        }
        continue;
      }

      let paneSelected = false;
      for (const pane of panes) {
        const paneKey = `p:${pane.id}`;
        const onScreen = live && w.id === activeWindowId;
        const paneActive = showing && onScreen && pane.id === activePaneId;
        const zoomed = onScreen ? pane.id === zoomedPaneId : pane.zoomed;
        const selectPane: ClientMessage = { type: "pane:select", id: pane.id };
        const command = isShellCommand(pane.command)
          ? pane.command || "shell"
          : pane.command!;

        const paneMenu: TreeAction[] = [
          ...(paneActive
            ? []
            : [
                {
                  label: "Focus",
                  icon: SquareTerminal,
                  onSelect: () => inSession(name, [selectPane]),
                },
              ]),
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
              ]),
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
                  destructive: true,
                  separated: true,
                  onSelect: () =>
                    setConfirm({
                      title: `Kill pane ${pane.index}?`,
                      description:
                        "The pane and every process running in it are terminated. This cannot be undone.",
                      action: "Kill pane",
                      run: () =>
                        inSession(name, [{ type: "pane:kill", id: pane.id }]),
                    }),
                },
              ]),
        ];

        if (paneActive) {
          selectedKey = paneKey;
          paneSelected = true;
        }
        rows.push({
          key: paneKey,
          parentKey: windowKey,
          depth: 2,
          prefix: String(pane.index),
          label: command,
          secondary: pane.path ? tailPath(pane.path) : undefined,
          title: `${command}${pane.path ? ` in ${pane.path}` : ""}, ${pane.dimensions.cols}x${pane.dimensions.rows}`,
          selected: paneActive,
          pending: pendingKey === pane.id,
          activate: () => inSession(name, [selectPane]),
          doubleClick: readOnly
            ? undefined
            : () => toggleZoom(name, pane, live, zoomed),
          remove: readOnly ? undefined : paneMenu.at(-1)?.onSelect,
          meta: zoomed ? (
            <Maximize2 className="h-3 w-3" aria-label="Zoomed" />
          ) : undefined,
          inline: readOnly
            ? []
            : [
                {
                  label: zoomed ? "Unzoom" : "Zoom",
                  icon: zoomed ? Minimize2 : Maximize2,
                  onSelect: () => toggleZoom(name, pane, live, zoomed),
                },
              ],
          menu: paneMenu,
        });
      }
      if (windowActive && !paneSelected) {
        selectedKey = windowKey;
        windowSelected = true;
      }
    }

    if (live && !readOnly) {
      rows.push({
        key: `new:${name}`,
        parentKey: sessionKey,
        depth: 1,
        label: "New window",
        icon: <Plus className="h-3.5 w-3.5 shrink-0" aria-hidden />,
        muted: true,
        activate: () => inSession(name, [{ type: "window:create" }]),
      });
    }
    if (isActive && !windowSelected && !selectedKey?.startsWith("p:")) {
      selectedKey = sessionKey;
    }
  }

  for (const row of rows) {
    if (row.key === selectedKey) row.selected = true;
  }

  const focusable = rows.filter((r) => !r.key.startsWith("status:"));
  const tabStop =
    (focusKey && focusable.some((r) => r.key === focusKey) && focusKey) ||
    selectedKey ||
    focusable[0]?.key ||
    null;

  const unreachable =
    !sessionsLoaded && (status === "disconnected" || status === "reconnecting");

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PanelHeader title="Sessions">
        {!readOnly && (
          <PanelIconButton
            label="New session"
            icon={Plus}
            onClick={onCreateSession}
            disabled={!connected}
          />
        )}
      </PanelHeader>

      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 py-1.5">
        {unreachable ? (
          <div className="flex flex-col items-start gap-3 px-2 py-6">
            <PlugZap className="h-5 w-5 text-muted-foreground" aria-hidden />
            <div>
              <p className="text-sm font-medium">Can&apos;t reach this machine</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Sessions keep running in tmux while the connection is down.
              </p>
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={() => getRelayClient()?.connect()}
            >
              <RefreshCw className="me-1 h-3.5 w-3.5" aria-hidden />
              Try again
            </Button>
          </div>
        ) : !sessionsLoaded ? (
          <div
            className="flex items-center gap-2 px-2 py-3 text-sm text-muted-foreground"
            role="status"
          >
            <Loader2
              className="h-4 w-4 animate-spin motion-reduce:animate-none"
              aria-hidden
            />
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
            className="space-y-px"
          >
            {rows.map((row) =>
              row.key.startsWith("status:") ? (
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
              ),
            )}
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
          onCloseAutoFocus={(event) => {
            if (!confirmed.current) return;
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

      <RequireUnlockDialog
        open={challenge !== null}
        onOpenChange={(open) => {
          if (!open) setChallenge(null);
        }}
        sessionName={challenge?.session ?? ""}
        onUnlocked={() => {
          const pending = challenge;
          setChallenge(null);
          pending?.run();
        }}
      />
    </div>
  );
}
