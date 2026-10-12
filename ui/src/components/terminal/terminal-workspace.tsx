import { useState, useCallback, useRef, useEffect } from "react";
import { useStableMediaQuery } from "@repo/ui/hooks/use-media-query";
import { MOBILE_MEDIA_QUERY } from "@/lib/mobile-query";
import {
  TerminalView,
  type TerminalViewHandle,
} from "@/components/terminal/terminal-view";
import { FloatingAlerts } from "@/components/alert-banner";
import { TerminalSearch } from "@/components/terminal/terminal-search";
import { TerminalScrollRail } from "@/components/terminal/terminal-scroll-rail";
import { SessionList } from "@/components/session/session-list";
import { WorkspaceSidebar } from "@/components/sidebar/workspace-sidebar";
import { MainTabs } from "@/components/terminal/main-tabs";
import { SessionCreateDialog } from "@/components/session/session-create-dialog";
import { RepositoryBrowser } from "@/components/files/repository-browser";
import { SettingsPanel } from "@/components/settings/settings-panel";
import { WindowTabs } from "@/components/mobile/window-tabs";
import { TmuxFab } from "@/components/mobile/tmux-fab";
import { PaneListPanel } from "@/components/mobile/pane-list-panel";
import { PaneOptionsSheet } from "@/components/mobile/pane-options-sheet";
import { PaneResizeControls } from "@/components/mobile/pane-resize-controls";
import { TerminalGestureSurface } from "@/components/terminal/terminal-gesture-surface";
import { SwitchHint } from "@/components/terminal/switch-hint";
import { DictationIndicator } from "@/components/dictation/dictation-indicator";
import { cn } from "@repo/ui/lib/utils";
import { getFileViewMode } from "@/lib/file-utils";
import { useSessionStore } from "@/stores/session-store";
import { useFileStore } from "@/stores/file-store";
import { useUiStore } from "@/stores/ui-store";
import { TERMINAL_TAB, useMainTabsStore } from "@/stores/main-tabs-store";
import { useWheelScroll } from "@/hooks/use-wheel-scroll";
import { lazyComponent } from "@/lib/lazy-component";
import { leaveCopyMode } from "@/lib/terminal-scroll";
import { getTerminalHandle } from "@/components/terminal/terminal-handle";

const FileEditor = lazyComponent(() =>
  import("@/components/files/file-editor").then((m) => m.FileEditor),
);

const FileTabView = lazyComponent(() =>
  import("@/components/files/file-tab-view").then((m) => m.FileTabView),
);

const CommitTabView = lazyComponent(() =>
  import("@/components/files/commit-tab-view").then((m) => m.CommitTabView),
);

const FileViewer = lazyComponent(() =>
  import("@/components/files/file-viewer").then((m) => m.FileViewer),
);

const CopyModeOverlay = lazyComponent(() =>
  import("@/components/mobile/copy-mode-overlay").then((m) => m.CopyModeOverlay),
);

/**
 * The terminal, its sidebar, its file panes and every mobile tab.
 *
 * This was the body of the terminal page, and it is a component now because
 * two routes need it. `/` is the one everything links to. `/s/<name>` deep-links
 * a specific tmux session — and used to `return null`, so following one of those
 * links rendered an empty shell. It set the active session in an effect and
 * trusted "the terminal is rendered by the parent layout", which was never true:
 * the layout renders `children`, and that child was the null.
 */
export function TerminalWorkspace() {
  const isMobile = useStableMediaQuery(MOBILE_MEDIA_QUERY);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const editorFile = useFileStore((s) => s.editorFile);
  const editorForceText = useFileStore((s) => s.editorForceText);
  const mobileTab = useUiStore((s) => s.mobileTab);
  const setMobileTab = useUiStore((s) => s.setMobileTab);
  const copyModeOpen = useUiStore((s) => s.copyModeOpen);
  // Opened from the mobile keyboard toolbar, which lives in the layout's footer
  // and so can only reach the terminal through the store.
  const terminalSearchOpen = useUiStore((s) => s.terminalSearchOpen);
  const setTerminalSearchOpen = useUiStore((s) => s.setTerminalSearchOpen);
  const mainTabs = useMainTabsStore((s) => s.tabs);
  const mainTab = useMainTabsStore((s) => s.active);
  const activeTab =
    mainTab === TERMINAL_TAB
      ? undefined
      : mainTabs.find((tab) => tab.id === mainTab);
  const terminalRef = useRef<TerminalViewHandle>(null);
  /*
   * The terminal pane, for the wheel — see `useWheelScroll`.
   *
   * One callback ref shared by both layouts: only one of them is ever mounted,
   * and a callback ref is what lets the listener follow the swap between them.
   */
  const paneRef = useWheelScroll();

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

  // Same repaint on desktop, on the way back from a file or settings tab. The
  // terminal stays laid out while hidden, for the reason given above.
  useEffect(() => {
    if (isMobile || activeTab) return;
    const frame = requestAnimationFrame(() => terminalRef.current?.redraw());
    return () => cancelAnimationFrame(frame);
  }, [isMobile, activeTab]);

  /*
   * A plain click on the terminal leaves copy mode on desktop, as a tap does
   * on a phone. Only on the terminal itself, so the scroll rail and the find
   * bar keep their own clicks, and not after a drag that selected text.
   */
  const handleTerminalClick = useCallback((event: React.MouseEvent) => {
    if (event.button !== 0) return;
    if (!(event.target instanceof Element) || !event.target.closest(".xterm"))
      return;
    if (getTerminalHandle()?.getSelection()) return;
    leaveCopyMode();
  }, []);

  const handleSearch = useCallback((term: string) => {
    terminalRef.current?.search(term);
  }, []);

  const handleSearchNext = useCallback(() => {
    terminalRef.current?.findNext();
  }, []);

  const handleSearchPrevious = useCallback(() => {
    terminalRef.current?.findPrevious();
  }, []);

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
            <WindowTabs className="tmuxde-hide-when-keyboard" />
            <div ref={paneRef} className="relative flex-1 overflow-hidden">
              {/* One recogniser for scroll, swipe and pinch — the three used
                  to be split across two stacked components that fought each
                  other. See lib/touch-gestures.ts. */}
              <TerminalGestureSurface className="absolute inset-0">
                <TerminalView
                  ref={terminalRef}
                  sessionName={activeSessionId}
                  // Narrower gutter than desktop: the edge here is the screen,
                  // and every column counts. See the desktop layout for why
                  // the padding sits on `.xterm`.
                  className="h-full [&_.xterm]:px-1"
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
              {/* Actions open from More, outside terminal gesture handling. */}
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
          {mobileTab === "files" && (
            <RepositoryBrowser className="min-h-0 flex-1" />
          )}
        </div>
        <div
          className={cn(
            "h-full flex-col",
            mobileTab === "settings" ? "flex" : "hidden",
          )}
        >
          <SettingsPanel className="h-full" />
        </div>
        {/* Outside the terminal tab, which turns invisible on the others, and
            the toolbar mic goes with it. A live microphone must stay visible
            whatever tab is open. */}
        <DictationIndicator />
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
        <PaneOptionsSheet />
        <PaneResizeControls />
        <SessionCreateDialog
          open={showCreateDialog}
          onOpenChange={setShowCreateDialog}
        />
      </div>
    );
  }

  // Desktop layout: rail and sidebar, then the main area. File and settings
  // tabs share the main area with the terminal, which stays mounted under them.
  const tabActive = !!activeTab;
  return (
    <div className="absolute inset-0 flex">
      <WorkspaceSidebar onCreateSession={() => setShowCreateDialog(true)} />

      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <MainTabs />
        <div className="relative min-h-0 flex-1">
          <div
            className={cn(
              "absolute inset-0 flex flex-col",
              tabActive && "invisible pointer-events-none",
            )}
            inert={tabActive}
          >
            <div
              ref={paneRef}
              className="relative flex-1 overflow-hidden"
              onClick={handleTerminalClick}
            >
              {/* Gutter between sidebar border and column one. Output with no
                  leading space of its own sat flush against the border. The
                  padding goes on xterm's `.xterm` element, not this box: the
                  fit addon subtracts that element's padding when it counts
                  columns, so nothing is clipped, and xterm's viewport covers
                  the padding box so the gutter paints in the theme
                  background. */}
              <TerminalView
                ref={terminalRef}
                sessionName={activeSessionId}
                className="h-full [&_.xterm]:px-2"
                onCreateSession={() => setShowCreateDialog(true)}
              />
              <SwitchHint />
              {/* Floats like a browser find bar. Opened from the command
                  palette. */}
              {terminalSearchOpen && (
                <TerminalSearch
                  className="absolute end-6 top-2 z-[var(--z-banner)] w-80"
                  onSearch={handleSearch}
                  onNext={handleSearchNext}
                  onPrevious={handleSearchPrevious}
                  onClose={() => setTerminalSearchOpen(false)}
                />
              )}
              <TerminalScrollRail sessionName={activeSessionId} />
            </div>
          </div>
          {activeTab?.kind === "file" && (
            <FileTabView
              key={activeTab.id}
              tab={activeTab}
              className="absolute inset-0"
            />
          )}
          {activeTab?.kind === "commit" && (
            <CommitTabView
              key={activeTab.id}
              tab={activeTab}
              className="absolute inset-0"
            />
          )}
          {activeTab?.kind === "settings" && (
            <SettingsPanel touch={false} className="absolute inset-0" />
          )}
          <FloatingAlerts />
          {/* Outside the terminal box, which turns invisible under a file
              tab. A live microphone must stay visible whatever is open. */}
          <DictationIndicator />
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
