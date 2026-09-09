"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { useStableMediaQuery } from "@repo/ui/hooks/use-media-query";
import { MOBILE_MEDIA_QUERY } from "@/lib/mobile-query";
import {
  TerminalView,
  type TerminalViewHandle,
} from "@/components/terminal/terminal-view";
import { TerminalToolbar } from "@/components/terminal/terminal-toolbar";
import { TerminalSearch } from "@/components/terminal/terminal-search";
import { TerminalScrollRail } from "@/components/terminal/terminal-scroll-rail";
import { SessionList } from "@/components/session/session-list";
import { SessionCreateDialog } from "@/components/session/session-create-dialog";
import { FileTree } from "@/components/files/file-tree";
import { SettingsPanel } from "@/components/settings/settings-panel";
import { WindowTabs } from "@/components/mobile/window-tabs";
import { TmuxFab } from "@/components/mobile/tmux-fab";
import { PaneListPanel } from "@/components/mobile/pane-list-panel";
import { PaneResizeControls } from "@/components/mobile/pane-resize-controls";
import { TerminalGestureSurface } from "@/components/terminal/terminal-gesture-surface";
import { SwitchHint } from "@/components/terminal/switch-hint";
import { cn } from "@repo/ui/lib/utils";
import { getFileViewMode } from "@/lib/file-utils";
import { PanelLeftClose, PanelLeft } from "lucide-react";
import { Button } from "@repo/ui/components/ui/button";
import { useSessionStore } from "@/stores/session-store";
import { useFileStore } from "@/stores/file-store";
import { useUiStore } from "@/stores/ui-store";
import { getRelayClient } from "@/hooks/use-websocket";
import { useWheelScroll } from "@/hooks/use-wheel-scroll";

const FileEditor = dynamic(
  () =>
    import("@/components/files/file-editor").then((m) => ({
      default: m.FileEditor,
    })),
  { ssr: false },
);

const FileViewer = dynamic(
  () =>
    import("@/components/files/file-viewer").then((m) => ({
      default: m.FileViewer,
    })),
  { ssr: false },
);

const CopyModeOverlay = dynamic(
  () =>
    import("@/components/mobile/copy-mode-overlay").then((m) => ({
      default: m.CopyModeOverlay,
    })),
  { ssr: false },
);

/**
 * The terminal, its sidebar, its file panes and every mobile tab.
 *
 * This was the body of `(terminal)/page.tsx`, and it is a component now because
 * two routes need it. `/` is the one everything links to. `/s/<name>` deep-links
 * a specific tmux session — and used to `return null`, so following one of those
 * links rendered an empty shell. It set the active session in an effect and
 * trusted "the terminal is rendered by the parent layout", which was never true:
 * the layout renders `children`, and that child was the null.
 */
export function TerminalWorkspace() {
  const router = useRouter();
  const isMobile = useStableMediaQuery(MOBILE_MEDIA_QUERY);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const setSelectedFile = useFileStore((s) => s.setSelectedFile);
  const editorFile = useFileStore((s) => s.editorFile);
  const editorForceText = useFileStore((s) => s.editorForceText);
  const openEditor = useFileStore((s) => s.openEditor);
  const mobileTab = useUiStore((s) => s.mobileTab);
  const setMobileTab = useUiStore((s) => s.setMobileTab);
  const sidebarCollapsed = useUiStore((s) => s.sidebarCollapsed);
  const copyModeOpen = useUiStore((s) => s.copyModeOpen);
  // Opened from the mobile keyboard toolbar, which lives in the layout's footer
  // and so can only reach the terminal through the store.
  const terminalSearchOpen = useUiStore((s) => s.terminalSearchOpen);
  const setTerminalSearchOpen = useUiStore((s) => s.setTerminalSearchOpen);
  const toggleSidebar = useUiStore((s) => s.toggleSidebar);
  const terminalRef = useRef<TerminalViewHandle>(null);
  /*
   * The terminal pane, for the wheel — see `useWheelScroll`.
   *
   * One callback ref shared by both layouts: only one of them is ever mounted,
   * and a callback ref is what lets the listener follow the swap between them.
   */
  const paneRef = useWheelScroll();
  const [isFullscreen, setIsFullscreen] = useState(false);
  const currentPath = useFileStore((s) => s.currentPath);
  const setCurrentPath = useFileStore((s) => s.setCurrentPath);
  const setIsLoading = useFileStore((s) => s.setIsLoading);

  // #3: Auto-switch to terminal tab on session attach
  useEffect(() => {
    if (activeSessionId && isMobile) {
      setMobileTab("terminal");
    }
  }, [activeSessionId, isMobile, setMobileTab]);

  /*
   * Repaint on the way back to the terminal tab.
   *
   * The tab swap is `visibility: hidden` rather than `display: none` (see the
   * comment on the pane below, which explains why that has to stay), and a
   * hidden-but-laid-out element never stops intersecting — so the
   * `IntersectionObserver` refit inside `TerminalView` does not fire on the way
   * back, and neither does anything else. The terminal was left holding a
   * canvas sized for whatever the layout was when it was last painted, which is
   * the "it goes blurry when I come back" report.
   *
   * Twice: once on the next frame for the common case, and once after the tab
   * transition has settled, because a fit against a box that is still moving
   * measures the wrong box.
   */
  useEffect(() => {
    if (!isMobile || mobileTab !== "terminal") return;
    const frame = requestAnimationFrame(() => terminalRef.current?.redraw());
    const settle = setTimeout(() => terminalRef.current?.redraw(), 300);
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(settle);
    };
  }, [isMobile, mobileTab]);

  // #2: Navigate handler for inline breadcrumb
  const handleBreadcrumbNavigate = useCallback(
    (path: string) => {
      setCurrentPath(path);
      setIsLoading(true);
      getRelayClient()?.send({ type: "file:list", path });
    },
    [setCurrentPath, setIsLoading],
  );

  const handleFileSelect = useCallback(
    (path: string) => {
      setSelectedFile(path);
      openEditor(path);
    },
    [setSelectedFile, openEditor],
  );

  const handleSearch = useCallback((term: string) => {
    terminalRef.current?.search(term);
  }, []);

  const handleSearchNext = useCallback(() => {
    terminalRef.current?.findNext();
  }, []);

  const handleSearchPrevious = useCallback(() => {
    terminalRef.current?.findPrevious();
  }, []);

  const handleToggleFullscreen = useCallback(() => {
    if (!document.fullscreenElement) {
      document.documentElement
        .requestFullscreen()
        .then(() => setIsFullscreen(true))
        .catch(() => {});
    } else {
      document
        .exitFullscreen()
        .then(() => setIsFullscreen(false))
        .catch(() => {});
    }
  }, []);

  const handleOpenSettings = useCallback(() => {
    if (isMobile) {
      setMobileTab("settings");
    } else {
      router.push("/settings");
    }
  }, [isMobile, setMobileTab, router]);

  if (isMobile) {
    return (
      <div className="absolute inset-0 overflow-hidden">
        {/* Terminal tab: use visibility+absolute instead of display:none to keep xterm's
            internal renderer dimensions valid and prevent Viewport ResizeObserver crashes */}
        <div
          className={cn(
            "h-full flex flex-col",
            mobileTab !== "terminal" &&
              "invisible absolute inset-0 pointer-events-none",
          )}
        >
          <div className="flex h-full flex-col">
            <WindowTabs />
            <div ref={paneRef} className="relative flex-1 overflow-hidden">
              {/* One recogniser for scroll, swipe and pinch — the three used
                  to be split across two stacked components that fought each
                  other. See lib/touch-gestures.ts. */}
              <TerminalGestureSurface className="absolute inset-0">
                <TerminalView
                  ref={terminalRef}
                  sessionName={activeSessionId}
                  className="h-full"
                  onCreateSession={() => setShowCreateDialog(true)}
                />
              </TerminalGestureSurface>
              <SwitchHint />
              {terminalSearchOpen && (
                <TerminalSearch
                  className="absolute inset-x-2 top-2 z-[var(--z-banner)]"
                  onSearch={handleSearch}
                  onNext={handleSearchNext}
                  onPrevious={handleSearchPrevious}
                  onClose={() => setTerminalSearchOpen(false)}
                />
              )}
              {/* Siblings of the gesture surface, not children, so their own
                  touches never reach the recogniser. Lives inside the terminal
                  pane rather than the viewport: as a `fixed` element the FAB
                  overlapped the command bar's send button. */}
              <TmuxFab />
              {/* A sibling of the gesture surface, like everything else that
                  needs its own touches: `touch-action: none` cannot be given
                  back to a descendant. */}
              <TerminalScrollRail sessionName={activeSessionId} />
            </div>
          </div>
        </div>
        <div
          className={cn(
            "h-full flex-col",
            mobileTab === "sessions" ? "flex" : "hidden",
          )}
        >
          <SessionList
            onCreateClick={() => setShowCreateDialog(true)}
            className="flex-1"
          />
        </div>
        <div
          className={cn(
            "h-full flex-col",
            mobileTab === "files" ? "flex" : "hidden",
          )}
        >
          <FileTree
            onFileSelect={handleFileSelect}
            className="flex-1"
            breadcrumbPath={currentPath}
            onNavigate={handleBreadcrumbNavigate}
          />
        </div>
        <div
          className={cn(
            "h-full flex-col",
            mobileTab === "settings" ? "flex" : "hidden",
          )}
        >
          <SettingsPanel className="h-full" />
        </div>
        {/* File editor overlay */}
        {editorFile &&
          (editorForceText || getFileViewMode(editorFile) === "text" ? (
            <FileEditor />
          ) : (
            <FileViewer />
          ))}
        {/* Copy mode overlay */}
        {copyModeOpen && <CopyModeOverlay />}
        <PaneListPanel />
        <PaneResizeControls />
        <SessionCreateDialog
          open={showCreateDialog}
          onOpenChange={setShowCreateDialog}
        />
      </div>
    );
  }

  // Desktop layout: sidebar + terminal + optional file preview
  return (
    <div className="absolute inset-0 flex">
      {/* Session sidebar */}
      <div
        className={cn(
          "flex shrink-0 flex-col border-r transition-[width] duration-200",
          sidebarCollapsed ? "w-12" : "w-64",
        )}
      >
        <div className="flex items-center justify-between border-b px-1 py-1">
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={toggleSidebar}
            title={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            {sidebarCollapsed ? (
              <PanelLeft className="h-4 w-4" />
            ) : (
              <PanelLeftClose className="h-4 w-4" />
            )}
          </Button>
        </div>
        {!sidebarCollapsed && (
          <SessionList
            onCreateClick={() => setShowCreateDialog(true)}
            className="flex-1"
          />
        )}
      </div>

      {/* Main terminal area */}
      <div className="flex flex-1 flex-col overflow-hidden">
        <TerminalToolbar
          onSearch={handleSearch}
          onSearchNext={handleSearchNext}
          onSearchPrevious={handleSearchPrevious}
          onToggleFullscreen={handleToggleFullscreen}
          onOpenSettings={handleOpenSettings}
          isFullscreen={isFullscreen}
        />
        {/* Windows are not a mobile concept. The desktop client used to have
            no window affordance at all, so a session with three windows looked
            like a session with one. */}
        <WindowTabs />
        <div ref={paneRef} className="relative flex-1 overflow-hidden">
          <TerminalView
            ref={terminalRef}
            sessionName={activeSessionId}
            className="h-full"
            onCreateSession={() => setShowCreateDialog(true)}
          />
          <SwitchHint />
          <TerminalScrollRail sessionName={activeSessionId} />
        </div>
      </div>

      {/* File editor overlay */}
      {editorFile &&
        (editorForceText || getFileViewMode(editorFile) === "text" ? (
          <FileEditor />
        ) : (
          <FileViewer />
        ))}

      <SessionCreateDialog
        open={showCreateDialog}
        onOpenChange={setShowCreateDialog}
      />
    </div>
  );
}
