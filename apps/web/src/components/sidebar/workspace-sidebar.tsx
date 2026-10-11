"use client";

import { useEffect, useRef } from "react";
import {
  FolderTree,
  GitCompareArrows,
  History,
  Images,
  Settings,
  SquareTerminal,
} from "lucide-react";
import { cn } from "@repo/ui/lib/utils";
import type { ConnectionState } from "@repo/protocol";
import { getRelayClient } from "@/hooks/use-websocket";
import { usePhotoHistory } from "@/hooks/use-photo-history";
import { readStored, writeStored } from "@/lib/storage-keys";
import { MachineSwitcher } from "@/components/machines/machine-switcher";
import { filesDisabled, useConnectionStore } from "@/stores/connection-store";
import { SETTINGS_TAB, useMainTabsStore } from "@/stores/main-tabs-store";
import {
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  useUiStore,
  type SidebarView,
} from "@/stores/ui-store";
import { SessionTree } from "./session-tree";
import { FilesView } from "./files-view";
import { ChangesView } from "./changes-view";
import { HistoryView } from "./history-view";
import { PhotosView } from "./photos-view";
import { useRepositoryState } from "./use-repository-state";

const PREFS_KEY = "tmuxde-sidebar";
const VIEWS: SidebarView[] = [
  "sessions",
  "files",
  "changes",
  "history",
  "photos",
];
/** Views that read the active pane's repository. */
const REPO_VIEWS: SidebarView[] = ["files", "changes", "history"];

/** Load view, width and collapsed state once, then save on every change. */
function useSidebarPrefs() {
  useEffect(() => {
    try {
      const raw = readStored(PREFS_KEY);
      const saved = raw
        ? (JSON.parse(raw) as {
            view?: SidebarView;
            width?: number;
            collapsed?: boolean;
          })
        : null;
      if (saved) {
        const ui = useUiStore.getState();
        if (saved.view && VIEWS.includes(saved.view))
          useUiStore.setState({ sidebarView: saved.view });
        if (typeof saved.width === "number") ui.setSidebarWidth(saved.width);
        if (typeof saved.collapsed === "boolean")
          useUiStore.setState({ sidebarCollapsed: saved.collapsed });
      }
    } catch {
      /* Bad JSON or no storage. Defaults stand. */
    }
    return useUiStore.subscribe((s, prev) => {
      if (
        s.sidebarView === prev.sidebarView &&
        s.sidebarWidth === prev.sidebarWidth &&
        s.sidebarCollapsed === prev.sidebarCollapsed
      )
        return;
      try {
        writeStored(
          PREFS_KEY,
          JSON.stringify({
            view: s.sidebarView,
            width: s.sidebarWidth,
            collapsed: s.sidebarCollapsed,
          }),
        );
      } catch {
        /* Storage full or blocked. Keep it for this visit. */
      }
    });
  }, []);
}

/**
 * Desktop sidebar: an icon rail and one panel.
 *
 * The rail is always there, so a collapsed sidebar still reaches every view.
 * The panel shows one view at a time at full height and can be resized from
 * its trailing edge.
 */
export function WorkspaceSidebar({
  onCreateSession,
}: {
  onCreateSession: () => void;
}) {
  useSidebarPrefs();
  const collapsed = useUiStore((s) => s.sidebarCollapsed);
  const view = useUiStore((s) => s.sidebarView);
  const toggleView = useUiStore((s) => s.toggleSidebarView);
  const showView = useUiStore((s) => s.showSidebarView);
  const capabilities = useConnectionStore((s) => s.capabilities);
  const noFiles = filesDisabled(capabilities);
  const { paths } = usePhotoHistory();
  const settingsActive = useMainTabsStore((s) => s.active === SETTINGS_TAB);

  const repoVisible = !collapsed && REPO_VIEWS.includes(view);
  const repo = useRepositoryState(repoVisible);
  const { refreshStatus } = repo;

  // Opening a repository view asks again. The badge may be minutes old.
  useEffect(() => {
    if (repoVisible) refreshStatus();
  }, [repoVisible, view, refreshStatus]);

  // A share without file access has no repository views to show.
  useEffect(() => {
    if (noFiles && REPO_VIEWS.includes(view)) showView("sessions");
  }, [noFiles, view, showView]);

  const changeCount = repo.status?.entries.length ?? 0;
  const open = (v: SidebarView) => !collapsed && view === v;

  return (
    <div className="flex shrink-0 font-chrome">
      <nav
        aria-label="Sidebar"
        className="flex w-12 shrink-0 flex-col items-center gap-1 border-e bg-surface-sunken py-1.5"
      >
        <RailButton
          label="Sessions"
          icon={SquareTerminal}
          active={open("sessions")}
          onClick={() => toggleView("sessions")}
        />
        {!noFiles && (
          <>
            <RailButton
              label="Files (Ctrl+E)"
              icon={FolderTree}
              active={open("files")}
              onClick={() => toggleView("files")}
            />
            <RailButton
              label={
                changeCount
                  ? `Changes, ${changeCount} file${changeCount === 1 ? "" : "s"}`
                  : "Changes"
              }
              icon={GitCompareArrows}
              active={open("changes")}
              badge={changeCount}
              onClick={() => toggleView("changes")}
            />
            <RailButton
              label="History"
              icon={History}
              active={open("history")}
              onClick={() => toggleView("history")}
            />
          </>
        )}
        <RailButton
          label={paths.length ? `Photos, ${paths.length}` : "Photos"}
          icon={Images}
          active={open("photos")}
          onClick={() => toggleView("photos")}
        />

        <div className="mt-auto flex flex-col items-center gap-1">
          <RailConnection />
          <MachineSwitcher compact />
          {/* Opens settings as a main-area tab. A second click goes back to
              the terminal and leaves the tab open. */}
          <RailButton
            label="Settings"
            icon={Settings}
            active={settingsActive}
            onClick={() => {
              const tabs = useMainTabsStore.getState();
              if (settingsActive) tabs.showTerminal();
              else tabs.openSettings();
            }}
          />
        </div>
      </nav>

      {!collapsed && (
        <SidebarPanel>
          {view === "sessions" && (
            <SessionTree onCreateSession={onCreateSession} />
          )}
          {view === "files" && !noFiles && <FilesView repo={repo} />}
          {view === "changes" && !noFiles && <ChangesView repo={repo} />}
          {view === "history" && !noFiles && <HistoryView repo={repo} />}
          {view === "photos" && <PhotosView />}
        </SidebarPanel>
      )}
    </div>
  );
}

/**
 * The resizable panel. It alone reads the width, so a drag re-renders this box
 * and its handle. The view comes in as `children`, elements the sidebar made,
 * and React skips them. Reading the width in the sidebar re-rendered the whole
 * view on every frame of a drag, a few hundred rows in History.
 */
function SidebarPanel({ children }: { children: React.ReactNode }) {
  const width = useUiStore((s) => s.sidebarWidth);
  return (
    <div className="relative flex min-w-0 flex-col border-e" style={{ width }}>
      {children}
      <ResizeHandle />
    </div>
  );
}

function RailButton({
  label,
  icon: Icon,
  active,
  badge,
  onClick,
}: {
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  active: boolean;
  badge?: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      title={label}
      onClick={onClick}
      className={cn(
        "relative flex h-9 w-9 items-center justify-center rounded-md transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        active
          ? "bg-accent text-foreground"
          : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
      )}
    >
      {/* Marks the open view at the rail's leading edge. */}
      {active && (
        <span
          aria-hidden
          className="absolute -start-1.5 top-2 bottom-2 w-0.5 rounded-full bg-primary"
        />
      )}
      <Icon className="h-[18px] w-[18px]" />
      {!!badge && (
        <span
          aria-hidden
          className="absolute -end-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[11px] font-medium tabular-nums text-primary-foreground"
        >
          {badge > 99 ? "99+" : badge}
        </span>
      )}
    </button>
  );
}

const DOT: Record<ConnectionState, { color: string; label: string }> = {
  connected: { color: "bg-success", label: "Connected" },
  connecting: { color: "bg-warning", label: "Connecting" },
  authenticating: { color: "bg-warning", label: "Connecting" },
  reconnecting: { color: "bg-warning", label: "Reconnecting" },
  disconnected: { color: "bg-destructive", label: "Disconnected" },
};

/** Connection dot. Latency in the tooltip. Click reconnects when down. */
function RailConnection() {
  // Field by field. `setLatency` writes on every pong.
  const status = useConnectionStore((s) => s.status);
  const latency = useConnectionStore((s) => s.latency);
  const dot = DOT[status] ?? DOT.disconnected;
  const down = status === "disconnected" || status === "reconnecting";
  const label =
    status === "connected" && latency != null
      ? `${dot.label}, ${latency}ms`
      : down
        ? `${dot.label}. Click to reconnect`
        : dot.label;
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={!down}
      onClick={() => {
        const client = getRelayClient();
        if (!client) return;
        client.disconnect();
        client.connect();
      }}
      className="flex h-9 w-9 items-center justify-center rounded-md enabled:hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
    >
      <span
        aria-hidden
        className={cn(
          "h-2.5 w-2.5 rounded-full",
          dot.color,
          status !== "connected" &&
            status !== "disconnected" &&
            "animate-pulse motion-reduce:animate-none",
        )}
      />
    </button>
  );
}

/** Drag, arrow keys or double click to reset. */
function ResizeHandle() {
  const width = useUiStore((s) => s.sidebarWidth);
  const setWidth = useUiStore((s) => s.setSidebarWidth);
  const cleanup = useRef<(() => void) | null>(null);
  useEffect(() => () => cleanup.current?.(), []);

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget;
    const startX = event.clientX;
    const startWidth = useUiStore.getState().sidebarWidth;
    const direction = getComputedStyle(handle).direction === "rtl" ? -1 : 1;
    let frame = 0;
    handle.setPointerCapture(event.pointerId);
    const body = document.body.style;
    const previous = { cursor: body.cursor, userSelect: body.userSelect };
    body.cursor = "col-resize";
    body.userSelect = "none";

    const move = (e: PointerEvent) => {
      const next = startWidth + (e.clientX - startX) * direction;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setWidth(next));
    };
    const end = () => {
      cancelAnimationFrame(frame);
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", end);
      handle.removeEventListener("pointercancel", end);
      body.cursor = previous.cursor;
      body.userSelect = previous.userSelect;
      cleanup.current = null;
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
    cleanup.current = end;
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      aria-valuemin={SIDEBAR_MIN_WIDTH}
      aria-valuemax={SIDEBAR_MAX_WIDTH}
      aria-valuenow={width}
      tabIndex={0}
      title="Drag to resize. Double click to reset."
      onPointerDown={onPointerDown}
      onDoubleClick={() => setWidth(SIDEBAR_DEFAULT_WIDTH)}
      onKeyDown={(event) => {
        const step = event.shiftKey ? 64 : 16;
        const rtl = getComputedStyle(event.currentTarget).direction === "rtl";
        const grow = rtl ? "ArrowLeft" : "ArrowRight";
        const shrink = rtl ? "ArrowRight" : "ArrowLeft";
        if (event.key === grow) setWidth(width + step);
        else if (event.key === shrink) setWidth(width - step);
        else if (event.key === "Home") setWidth(SIDEBAR_MIN_WIDTH);
        else if (event.key === "End") setWidth(SIDEBAR_MAX_WIDTH);
        else return;
        event.preventDefault();
      }}
      className="group absolute inset-y-0 -end-1 z-10 flex w-2 cursor-col-resize touch-none justify-center focus-visible:outline-none"
    >
      <span
        aria-hidden
        className="w-px bg-transparent transition-colors group-hover:bg-ring/60 group-focus-visible:bg-ring"
      />
    </div>
  );
}
