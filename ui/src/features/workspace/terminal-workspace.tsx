import { MachineContent } from "./machine-workspace";
import { useState, useCallback, useRef, useEffect } from "react";
import { useStableMediaQuery } from "@/shared/use-media-query";
import { MOBILE_MEDIA_QUERY } from "@/shared/mobile-query";
import { TerminalView, type TerminalViewHandle } from "@/features/terminal/terminal-view";
import { FloatingAlerts } from "@/shared/alert-banner";
import { TerminalSearch } from "@/features/terminal/terminal-search";
import { TerminalScrollRail } from "@/features/terminal/terminal-scroll-rail";
import { MachinesTree } from "./machines-tree";
import { useMachineStore } from "@/features/connection/machine-store";
import { useSessionTreeStore } from "@/features/session/session-tree-store";
import { LAST_SESSION_KEY, writeStored } from "@/features/connection/storage-keys";
import { machineId } from "@/features/connection/machine-context";
import { WorkspaceSidebar } from "./workspace-sidebar";
import { MainTabs } from "./main-tabs";
import { SessionCreateDialog } from "@/features/session/session-create-dialog";
import { RepositoryBrowser } from "@/features/repository/repository-browser";
import { SettingsPanel } from "@/features/settings/settings-panel";
import { OverviewView } from "@/features/panes/overview-view";
import { WindowTabs } from "@/features/mobile/window-tabs";
import { TmuxFab } from "@/features/mobile/tmux-fab";
import { PaneListPanel } from "@/features/mobile/pane-list-panel";
import { PaneOptionsSheet } from "@/features/mobile/pane-options-sheet";
import { PaneResizeControls } from "@/features/mobile/pane-resize-controls";
import { TerminalGestureSurface } from "@/features/terminal/terminal-gesture-surface";
import { SwitchHint } from "@/features/terminal/switch-hint";
import { DictationIndicator } from "@/features/dictation/dictation-indicator";
import { cn } from "@/shared/utils";
import { getFileViewMode } from "@/features/files/file-utils";
import { useSessionStore } from "@/features/session/session-store";
import { useFileStore } from "@/features/files/file-store";
import { useUiStore } from "./ui-store";
import { TERMINAL_TAB, isMachineTab, useMainTabsStore } from "./main-tabs-store";
import { useWheelScroll } from "@/features/terminal/use-wheel-scroll";
import { lazyComponent } from "@/shared/lazy-component";
import { leaveCopyMode } from "@/features/terminal/terminal-scroll";
import { getTerminalHandle } from "@/features/terminal/terminal-handle";

const FileEditor = lazyComponent(() =>
  import("@/features/files/file-editor").then((m) => m.FileEditor),
);

const FileTabView = lazyComponent(() =>
  import("@/features/files/file-tab-view").then((m) => m.FileTabView),
);

const ChangesTabView = lazyComponent(() =>
  import("@/features/repository/current-changes-view").then((m) => m.ChangesTabView),
);
const CommitTabView = lazyComponent(() =>
  import("@/features/repository/commit-tab-view").then((m) => m.CommitTabView),
);

const GraphTabView = lazyComponent(() =>
  import("@/features/repository/graph-tab-view").then((m) => m.GraphTabView),
);
const FileViewer = lazyComponent(() =>
  import("@/features/files/file-viewer").then((m) => m.FileViewer),
);

const CopyModeOverlay = lazyComponent(() =>
  import("@/features/mobile/copy-mode-overlay").then((m) => m.CopyModeOverlay),
);

/** Shared workspace chrome stays mounted across session and machine changes. */
export function TerminalWorkspace() {
  const isMobile = useStableMediaQuery(MOBILE_MEDIA_QUERY);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const activeMachine = useMachineStore((s) => s.activeMachine);
  /*
   * The new session dialog opens from this view's buttons, or from another
   * view through `createSession`, which often comes with a machine switch.
   * That request holds the dialog open once the switch lands. Closing the
   * dialog clears both.
   *
   * The request lasts no longer than this view. A lock unmounts it with the
   * dialog open, and the dialog must not come back, empty, after the unlock.
   */
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const createRequested = useMachineStore((s) => s.createSession && s.requested === null);
  const createDialogOpen = showCreateDialog || createRequested;
  const setCreateDialogOpen = useCallback((open: boolean) => {
    setShowCreateDialog(open);
    if (!open) useMachineStore.setState({ createSession: false });
  }, []);
  useEffect(
    () => () => {
      useMachineStore.setState({ createSession: false });
    },
    [],
  );
  useEffect(() => {
    if (activeSessionId) {
      useMachineStore.getState().openTerminal(machineId(), activeSessionId);
      writeStored(LAST_SESSION_KEY, activeSessionId);
    }
  }, [activeSessionId, activeMachine]);
  const attachedSession = useSessionTreeStore((s) => s.attachedSession);
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
  const selectedTab =
    mainTab === TERMINAL_TAB ? undefined : mainTabs.find((tab) => tab.id === mainTab);
  // Settings and the overview belong to no machine. Other tabs show once
  // their machine and session are the attached ones.
  const activeTab =
    selectedTab &&
    (!isMachineTab(selectedTab) ||
      ((selectedTab.machineId ?? "local") === machineId() &&
        (!selectedTab.sessionName || selectedTab.sessionName === attachedSession)))
      ? selectedTab
      : undefined;
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
    if (!(event.target instanceof Element) || !event.target.closest(".xterm")) return;
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

  // Reads every machine, so it stays outside `MachineContent` and lives
  // through a machine switch. Mounted only while in front: hidden, it would
  // still render on every inventory update of every machine.
  const overview =
    activeTab?.kind === "overview" ? <OverviewView className="absolute inset-0" /> : null;

  const tabContent = (
    <MachineContent>
      {selectedTab && !activeTab && (
        <div
          role="status"
          className="absolute inset-0 grid place-items-center bg-background text-sm text-muted-foreground"
        >
          Waiting for session on this machine
        </div>
      )}
      {activeTab?.kind === "file" && (
        <FileTabView key={activeTab.id} tab={activeTab} className="absolute inset-0" />
      )}
      {activeTab?.kind === "changes" && (
        <ChangesTabView key={activeTab.id} tab={activeTab} className="absolute inset-0" />
      )}
      {activeTab?.kind === "commit" && (
        <CommitTabView key={activeTab.id} tab={activeTab} className="absolute inset-0" />
      )}
      {/* Graphs stay mounted while hidden, so loaded pages, scroll and
          the last opened commit survive a trip to a commit tab. */}
      {mainTabs.map((tab) =>
        tab.kind === "graph" &&
        (tab.machineId ?? "local") === machineId() &&
        (!tab.sessionName || tab.sessionName === attachedSession) ? (
          <GraphTabView
            key={tab.id}
            tab={tab}
            active={activeTab?.id === tab.id}
            className={cn("absolute inset-0", activeTab?.id !== tab.id && "hidden")}
          />
        ) : null,
      )}
      {activeTab?.kind === "settings" && (
        <SettingsPanel touch={false} className="absolute inset-0" />
      )}
    </MachineContent>
  );

  if (isMobile) {
    return (
      <div className="absolute inset-0 overflow-hidden">
        {/* Terminal tab: use visibility+absolute instead of display:none to keep xterm's
            internal renderer dimensions valid and prevent Viewport ResizeObserver crashes */}
        <div
          className={cn(
            "h-full flex flex-col",
            mobileTab !== "terminal" && "invisible absolute inset-0 pointer-events-none",
          )}
        >
          <div className="flex h-full flex-col">
            <MainTabs />
            {!selectedTab && (
              <MachineContent>
                <WindowTabs className="tmuxde-hide-when-keyboard" />
              </MachineContent>
            )}
            <div ref={paneRef} className="relative flex-1 overflow-hidden">
              {/* One recogniser for scroll, swipe and pinch — the three used
                  to be split across two stacked components that fought each
                  other. See features/terminal/touch-gestures.ts. */}
              <TerminalGestureSurface
                className={cn("absolute inset-0", selectedTab && "invisible pointer-events-none")}
              >
                <MachineContent>
                  <TerminalView
                    ref={terminalRef}
                    sessionName={activeSessionId}
                    // Keep the gutter narrow on phone screens.
                    className="h-full [&_.xterm]:px-1"
                    onCreateSession={() => setShowCreateDialog(true)}
                  />
                </MachineContent>
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
              {!selectedTab && <TmuxFab />}
              {/* A sibling of the gesture surface, like everything else that
                  needs its own touches: `touch-action: none` cannot be given
                  back to a descendant. */}
              {!selectedTab && (
                <MachineContent>
                  <TerminalScrollRail sessionName={activeSessionId} />
                </MachineContent>
              )}
              {tabContent}
              {overview}
            </div>
          </div>
        </div>
        <div className={cn("h-full flex-col", mobileTab === "sessions" ? "flex" : "hidden")}>
          <MachinesTree
            onCreateSession={() => setShowCreateDialog(true)}
            visible={mobileTab === "sessions"}
          />
        </div>
        <div className={cn("h-full flex-col", mobileTab === "files" ? "flex" : "hidden")}>
          {mobileTab === "files" && (
            <MachineContent>
              <RepositoryBrowser className="min-h-0 flex-1" />
            </MachineContent>
          )}
        </div>
        <div className={cn("h-full flex-col", mobileTab === "settings" ? "flex" : "hidden")}>
          <SettingsPanel className="h-full" />
        </div>
        {/* Outside the terminal tab, which turns invisible on the others, and
            the toolbar mic goes with it. A live microphone must stay visible
            whatever tab is open. */}
        <DictationIndicator />
        {/* File editor overlay */}
        {editorFile &&
          (editorForceText || getFileViewMode(editorFile) === "text" ? (
            <MachineContent>
              <FileEditor />
            </MachineContent>
          ) : (
            <MachineContent>
              <FileViewer />
            </MachineContent>
          ))}
        {/* Copy mode overlay */}
        {copyModeOpen && (
          <MachineContent>
            <CopyModeOverlay />
          </MachineContent>
        )}
        <MachineContent>
          <PaneListPanel />
        </MachineContent>
        <MachineContent>
          <PaneOptionsSheet />
        </MachineContent>
        <MachineContent>
          <PaneResizeControls />
        </MachineContent>
        <MachineContent>
          <SessionCreateDialog open={createDialogOpen} onOpenChange={setCreateDialogOpen} />
        </MachineContent>
      </div>
    );
  }

  // Desktop layout: rail and sidebar, then the main area. File and settings
  // tabs share the main area with the terminal, which stays mounted under them.
  const tabActive = !!selectedTab;
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
              <MachineContent>
                <TerminalView
                  ref={terminalRef}
                  sessionName={activeSessionId}
                  className="h-full [&_.xterm]:px-2"
                  onCreateSession={() => setShowCreateDialog(true)}
                />
              </MachineContent>
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
              <MachineContent>
                <TerminalScrollRail sessionName={activeSessionId} />
              </MachineContent>
            </div>
          </div>
          {tabContent}
          {overview}
          <FloatingAlerts />
          {/* Outside the terminal box, which turns invisible under a file
              tab. A live microphone must stay visible whatever is open. */}
          <DictationIndicator />
        </div>
      </div>

      {/* File editor overlay */}
      {editorFile &&
        (editorForceText || getFileViewMode(editorFile) === "text" ? (
          <MachineContent>
            <FileEditor />
          </MachineContent>
        ) : (
          <MachineContent>
            <FileViewer />
          </MachineContent>
        ))}

      <MachineContent>
        <SessionCreateDialog open={createDialogOpen} onOpenChange={setCreateDialogOpen} />
      </MachineContent>
    </div>
  );
}
