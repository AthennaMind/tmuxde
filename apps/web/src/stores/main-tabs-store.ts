import { create } from "zustand";
import {
  createJSONStorage,
  persist,
  type StateStorage,
} from "zustand/middleware";
import { isEnrolled } from "@/lib/unlocked";

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

function isMainTab(value: unknown): value is MainTab {
  const tab = value as Partial<FileTab> | Partial<SettingsTab> | null;
  if (tab?.kind === "settings") return tab.id === SETTINGS_TAB;
  return (
    tab?.kind === "file" &&
    typeof tab.paneId === "string" &&
    typeof tab.path === "string" &&
    tab.id === fileTabId(tab as FileTab)
  );
}

/** Keep well formed tabs only, and an active id that still names one. */
export function restoreTabs(
  persisted: unknown,
): Pick<MainTabsStore, "tabs" | "active"> {
  const state = persisted as Partial<MainTabsStore> | undefined;
  const tabs = Array.isArray(state?.tabs)
    ? state.tabs.filter(isMainTab).slice(-MAX_TABS)
    : [];
  const active = tabs.find((t) => t.id === state?.active)?.id ?? TERMINAL_TAB;
  return { tabs, active };
}

/**
 * Pick where open tabs live.
 *
 * `localStorage` on a device with no lock, so tabs come back after a reload or
 * a restart. Once a lock is enrolled, paths stay out of `localStorage` for the
 * reason `command-store` gives. They go to `sessionStorage` instead. That still
 * survives a reload, ends with the browser tab, and is cleared by an erase.
 *
 * Read both: the store hydrates before the lock record says whether a lock is
 * enrolled, and a write always clears the other copy.
 */
function storages(): { keep: Storage; drop: Storage } | null {
  if (typeof window === "undefined") return null;
  try {
    return isEnrolled()
      ? { keep: window.sessionStorage, drop: window.localStorage }
      : { keep: window.localStorage, drop: window.sessionStorage };
  } catch {
    // Storage blocked by the browser. Tabs last until the page goes.
    return null;
  }
}

const tabStorage: StateStorage = {
  getItem: (key) => {
    const s = storages();
    return s ? (s.keep.getItem(key) ?? s.drop.getItem(key)) : null;
  },
  setItem: (key, value) => {
    const s = storages();
    if (!s) return;
    s.drop.removeItem(key);
    s.keep.setItem(key, value);
  },
  removeItem: (key) => {
    const s = storages();
    s?.keep.removeItem(key);
    s?.drop.removeItem(key);
  },
};

export const useMainTabsStore = create<MainTabsStore>()(
  persist(
    (set) => ({
      tabs: [],
      active: TERMINAL_TAB,
      openFile: (input) =>
        set((s) => {
          // Same file again: refresh what it points at, keep its place.
          const id = fileTabId(input);
          return {
            tabs: upsert(s.tabs, { ...input, kind: "file", id }),
            active: id,
          };
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
    }),
    {
      name: "tmuxde-main-tabs",
      version: 1,
      storage: createJSONStorage(() => tabStorage),
      partialize: (state) => ({ tabs: state.tabs, active: state.active }),
      merge: (persisted, current) => ({ ...current, ...restoreTabs(persisted) }),
    },
  ),
);
