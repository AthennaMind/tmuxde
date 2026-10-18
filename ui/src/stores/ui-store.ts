import { create } from "zustand";
import type { MobileTab } from "@/components/mobile/mobile-nav";

/** Views the desktop sidebar rail switches between. */
export type SidebarView = "sessions" | "files" | "changes" | "history" | "photos";

export const SIDEBAR_MIN_WIDTH = 220;
export const SIDEBAR_MAX_WIDTH = 480;
export const SIDEBAR_DEFAULT_WIDTH = 288;

export function clampSidebarWidth(width: number): number {
  return Math.round(Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, width)));
}

interface UiStore {
  mobileTab: MobileTab;
  paneListOpen: boolean;
  fabOpen: boolean;
  resizeModeActive: boolean;
  /** Desktop sidebar panel hidden. The rail stays. */
  sidebarCollapsed: boolean;
  sidebarView: SidebarView;
  sidebarWidth: number;
  copyModeOpen: boolean;
  terminalSearchOpen: boolean;
  capturedPaneId: string | null;
  capturedContent: string | null;
  /** The composer's draft, or null when it is closed. */
  composerDraft: string | null;
  /**
   * Transient pill naming what a switch just landed on.
   *
   * tmux's redraw after a window switch can be almost identical to the screen
   * you left — same shell, same prompt — so without this the honest answer to
   * "did anything happen?" is "you cannot tell".
   */
  switchHint: string | null;
  /**
   * The pane a long press opened the options menu for, or null when closed.
   *
   * A pane id rather than a boolean: the menu acts on the pane the finger
   * landed on, which is frequently not the active one — picking a *different*
   * pane and zooming it is most of the point of the gesture.
   */
  paneMenuId: string | null;
  setMobileTab: (tab: MobileTab) => void;
  setPaneListOpen: (open: boolean) => void;
  setFabOpen: (open: boolean) => void;
  setResizeModeActive: (active: boolean) => void;
  toggleSidebar: () => void;
  /** Show a view, opening the panel if it is collapsed. */
  showSidebarView: (view: SidebarView) => void;
  /** Rail click: a second click on the open view collapses the panel. */
  toggleSidebarView: (view: SidebarView) => void;
  setSidebarWidth: (width: number) => void;
  setCopyModeOpen: (open: boolean) => void;
  setTerminalSearchOpen: (open: boolean) => void;
  setCapturedPane: (id: string | null, content: string | null) => void;
  /** Open the composer, seeded with whatever was in the one-line bar. */
  openComposer: (draft?: string) => void;
  setComposerDraft: (draft: string) => void;
  setSwitchHint: (hint: string | null) => void;
  setPaneMenuId: (id: string | null) => void;
  closeComposer: () => void;
}

export const useUiStore = create<UiStore>((set) => ({
  mobileTab: "terminal",
  paneListOpen: false,
  fabOpen: false,
  resizeModeActive: false,
  sidebarCollapsed: false,
  sidebarView: "sessions",
  sidebarWidth: SIDEBAR_DEFAULT_WIDTH,
  copyModeOpen: false,
  terminalSearchOpen: false,
  capturedPaneId: null,
  capturedContent: null,
  composerDraft: null,
  switchHint: null,
  paneMenuId: null,
  setMobileTab: (mobileTab) => set({ mobileTab }),
  setPaneListOpen: (paneListOpen) => set({ paneListOpen }),
  setFabOpen: (fabOpen) => set({ fabOpen }),
  setResizeModeActive: (resizeModeActive) => set({ resizeModeActive }),
  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
  showSidebarView: (sidebarView) => set({ sidebarView, sidebarCollapsed: false }),
  toggleSidebarView: (view) =>
    set((s) =>
      !s.sidebarCollapsed && s.sidebarView === view
        ? { sidebarCollapsed: true }
        : { sidebarView: view, sidebarCollapsed: false },
    ),
  setSidebarWidth: (width) => set({ sidebarWidth: clampSidebarWidth(width) }),
  setCopyModeOpen: (copyModeOpen) =>
    set(
      copyModeOpen
        ? { copyModeOpen }
        : { copyModeOpen, capturedPaneId: null, capturedContent: null },
    ),
  setTerminalSearchOpen: (terminalSearchOpen) => set({ terminalSearchOpen }),
  setCapturedPane: (capturedPaneId, capturedContent) => set({ capturedPaneId, capturedContent }),
  setPaneMenuId: (paneMenuId) => set({ paneMenuId }),
  // `null` means closed and `""` means open-and-empty, which is why this is a
  // nullable draft rather than a boolean beside a string.
  openComposer: (draft = "") => set({ composerDraft: draft }),
  setComposerDraft: (composerDraft) => set({ composerDraft }),
  setSwitchHint: (switchHint) => set({ switchHint }),
  closeComposer: () => set({ composerDraft: null }),
}));
