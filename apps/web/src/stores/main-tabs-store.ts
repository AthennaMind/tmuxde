import { create } from "zustand";

export type ChangeScope = "staged" | "unstaged" | "untracked";

/**
 * A file or diff open in the desktop main area, beside the terminal tab.
 *
 * Carries the pane it was opened from. Repository requests are scoped to a
 * pane's directory, and the active pane moves while the tab stays open.
 */
export interface FileTab {
  kind: "file";
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

/** The settings page. At most one, opened from the rail or the palette. */
export interface SettingsTab {
  kind: "settings";
  id: typeof SETTINGS_TAB;
}

export type MainTab = FileTab | SettingsTab;

export const TERMINAL_TAB = "terminal";
export const SETTINGS_TAB = "settings";
const MAX_TABS = 12;

export function fileTabId(tab: Pick<FileTab, "path" | "scope">): string {
  return `${tab.scope ?? "file"}:${tab.path}`;
}

interface MainTabsStore {
  tabs: MainTab[];
  /** `TERMINAL_TAB` or a tab id. */
  active: string;
  openFile: (tab: Omit<FileTab, "id" | "kind">) => void;
  openSettings: () => void;
  closeTab: (id: string) => void;
  activate: (id: string) => void;
  showTerminal: () => void;
}

/** Replace a tab in place, or append it. Oldest goes once the strip is full. */
function upsert(tabs: MainTab[], tab: MainTab): MainTab[] {
  const existing = tabs.findIndex((t) => t.id === tab.id);
  if (existing < 0) return [...tabs, tab].slice(-MAX_TABS);
  const next = [...tabs];
  next[existing] = tab;
  return next;
}

export const useMainTabsStore = create<MainTabsStore>((set) => ({
  tabs: [],
  active: TERMINAL_TAB,
  openFile: (input) =>
    set((s) => {
      // Same file again: refresh what it points at, keep its place.
      const id = fileTabId(input);
      return { tabs: upsert(s.tabs, { ...input, kind: "file", id }), active: id };
    }),
  openSettings: () =>
    set((s) => ({
      tabs: upsert(s.tabs, { kind: "settings", id: SETTINGS_TAB }),
      active: SETTINGS_TAB,
    })),
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
