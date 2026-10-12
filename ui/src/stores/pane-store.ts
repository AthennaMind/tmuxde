import { create } from "zustand";
import type { PaneInfo, WindowInfo } from "@repo/protocol";

interface PaneStore {
  windows: WindowInfo[];
  panes: PaneInfo[];
  activeWindowId: string | null;
  activePaneId: string | null;
  zoomedPaneId: string | null;
  pendingAutoZoom: boolean;
  /**
   * The strip entry a swipe has committed to but the relay has not confirmed.
   *
   * Over a sealed tunnel the round trip is long enough that a swipe with no
   * immediate feedback reads as "nothing happened". Highlighting the target at
   * once and reconciling on the authoritative reply is what makes it feel
   * answered. Cleared by the next `setWindows`/`setPanes` or by a timeout.
   */
  pendingKey: string | null;
  setWindows: (windows: WindowInfo[]) => void;
  setPanes: (panes: PaneInfo[], windowId: string) => void;
  setActiveWindow: (id: string | null) => void;
  setActivePane: (id: string | null) => void;
  setZoomedPane: (id: string | null) => void;
  setPendingAutoZoom: (pending: boolean) => void;
  setPendingKey: (key: string | null) => void;
  clearAll: () => void;
}

export const usePaneStore = create<PaneStore>((set) => ({
  windows: [],
  panes: [],
  activeWindowId: null,
  activePaneId: null,
  zoomedPaneId: null,
  pendingAutoZoom: false,
  pendingKey: null,
  setWindows: (windows) =>
    set((state) => {
      const activeWin = windows.find((w) => w.active);
      return {
        windows,
        activeWindowId: activeWin?.id ?? null,
        pendingKey: null,
        // A window that says it is not zoomed settles the question for every
        // pane in it, and saying so here is what stops "Unzoom" being offered
        // for a pane that is already unzoomed. `zoomed` is optional in the
        // protocol, so an older relay leaves it undefined and the belief is
        // left exactly as it was — "cannot say" is not "no".
        //
        // Safe against the optimistic write in `lib/pane-zoom.ts`: every
        // window list is published beside the pane list that outranks it, and
        // the pane list is sent second.
        zoomedPaneId: activeWin?.zoomed === false ? null : state.zoomedPaneId,
      };
    }),
  // `panes` is now a single window's panes and `windowId` is the window tmux is
  // actually showing (see `currentWindowPanes` in the relay's router), so
  // exactly one pane carries `active` and at most one carries `zoomed`. When
  // this took an unscoped, all-windows listing, `find` here always resolved to
  // the first window's pane whatever window was on screen — the whole bug.
  setPanes: (panes, windowId) => {
    const activePane = panes.find((p) => p.active);
    const zoomedPane = panes.find((p) => p.zoomed);
    set({
      panes,
      activeWindowId: windowId || null,
      activePaneId: activePane?.id ?? null,
      zoomedPaneId: zoomedPane?.id ?? null,
      pendingKey: null,
    });
  },
  setActiveWindow: (activeWindowId) => set({ activeWindowId }),
  setActivePane: (activePaneId) => set({ activePaneId }),
  setZoomedPane: (zoomedPaneId) => set({ zoomedPaneId }),
  setPendingAutoZoom: (pendingAutoZoom) => set({ pendingAutoZoom }),
  setPendingKey: (pendingKey) => set({ pendingKey }),
  clearAll: () =>
    set({
      windows: [],
      panes: [],
      activeWindowId: null,
      activePaneId: null,
      zoomedPaneId: null,
      pendingAutoZoom: false,
      pendingKey: null,
    }),
}));
