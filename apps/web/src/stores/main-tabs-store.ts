import { create } from "zustand";

export type ChangeScope = "staged" | "unstaged" | "untracked";

/**
 * A file or diff open in the desktop main area, beside the terminal tab.
 *
 * Carries the pane it was opened from. Repository requests are scoped to a
 * pane's directory, and the active pane moves while the tab stays open.
 */
export interface FileTab {
  id: string;
  paneId: string;
  /** Absolute path for a file. Repository relative path for a diff. */
  path: string;
  /** Present for a diff: which side of the working tree. */
  scope?: ChangeScope;
  /** Pane directory the diff request is resolved against. */
  contextPath?: string;
  /** Repository root, so a diff tab can name its file in full. */
  root?: string | null;
  size?: number;
}

export const TERMINAL_TAB = "terminal";
const MAX_TABS = 12;

export function fileTabId(tab: Pick<FileTab, "path" | "scope">): string {
  return `${tab.scope ?? "file"}:${tab.path}`;
}

interface MainTabsStore {
  tabs: FileTab[];
  /** `TERMINAL_TAB` or a file tab id. */
  active: string;
  openFile: (tab: Omit<FileTab, "id">) => void;
  closeTab: (id: string) => void;
  activate: (id: string) => void;
  showTerminal: () => void;
}

export const useMainTabsStore = create<MainTabsStore>((set) => ({
  tabs: [],
  active: TERMINAL_TAB,
  openFile: (input) =>
    set((s) => {
      const id = fileTabId(input);
      const tab: FileTab = { ...input, id };
      const existing = s.tabs.findIndex((t) => t.id === id);
      if (existing >= 0) {
        // Same file again: refresh what it points at, keep its place.
        const tabs = [...s.tabs];
        tabs[existing] = tab;
        return { tabs, active: id };
      }
      // Oldest tab goes first once the strip is full.
      const tabs = [...s.tabs, tab].slice(-MAX_TABS);
      return { tabs, active: id };
    }),
  closeTab: (id) =>
    set((s) => {
      const index = s.tabs.findIndex((t) => t.id === id);
      if (index < 0) return s;
      const tabs = s.tabs.filter((t) => t.id !== id);
      if (s.active !== id) return { tabs };
      // Closing the open tab lands on its neighbour, then on the terminal.
      const next = tabs[index] ?? tabs[index - 1];
      return { tabs, active: next?.id ?? TERMINAL_TAB };
    }),
  activate: (active) => set({ active }),
  showTerminal: () => set({ active: TERMINAL_TAB }),
}));
