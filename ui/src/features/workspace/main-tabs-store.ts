import { machineId } from "@/features/connection/machine-context";
import { create } from "zustand";
import { USER_DOCUMENT_NAMES, type UserDocumentName } from "@/protocol";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";
import { useSessionStore } from "@/features/session/session-store";
import { isEnrolled } from "@/features/lock/unlocked";

export type ChangeScope = "staged" | "unstaged" | "untracked";

/**
 * A file or diff open in the desktop main area, beside the terminal tab.
 *
 * Carries the pane it was opened from. Repository requests are scoped to a
 * pane's directory, and the active pane moves while the tab stays open.
 */
export interface TabOrigin {
  machineId?: string;
  sessionName?: string | null;
}

export function tabOrigin(): TabOrigin {
  if (machineId() === "local" && !useSessionStore.getState().activeSessionId) return {};
  return {
    machineId: machineId(),
    sessionName: useSessionStore.getState().activeSessionId,
  };
}

function scopedId(id: string, machine = "local"): string {
  return machine === "local" ? id : `${machine}:${id}`;
}

export interface FileTab extends TabOrigin {
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
  /** Unknown when opened from a Markdown link. */
  size?: number;
  /** The tree listed the path as a symbolic link. */
  symlink?: boolean;
}

/**
 * One commit and its whole patch, opened from History.
 *
 * Commits never change, so the tab needs no reload. `contextPath` pins the
 * repository the way a diff tab does.
 */
export interface CommitTab extends TabOrigin {
  kind: "commit";
  id: string;
  paneId: string;
  /** Full hash. */
  hash: string;
  /** Empty until the commit loads when opened from a parent link. */
  subject: string;
  contextPath: string;
}

/**
 * Commit graph of every branch, tag and remote branch of one repository.
 *
 * Opened from History or the palette. `contextPath` pins the repository like
 * a commit tab, so the graph stays on it when the active pane moves. One tab
 * per repository.
 */
export interface GraphTab extends TabOrigin {
  kind: "graph";
  id: string;
  paneId: string;
  /** Absolute folder the log request is resolved against. */
  contextPath: string;
}

/** Current changes pinned to one machine and repository. */
export interface ChangesTab extends TabOrigin {
  kind: "changes";
  id: string;
  paneId: string;
  contextPath: string;
}

/** The settings page. At most one, opened from the rail or the palette. */
export interface SettingsTab {
  kind: "settings";
  id: typeof SETTINGS_TAB;
}

/**
 * Every window of every machine as a card. At most one, opened from the rail
 * or the palette. It has no origin, since it reads all machines at once.
 */
export interface OverviewTab {
  kind: "overview";
  id: typeof OVERVIEW_TAB;
}

/**
 * One of the hub's user documents as JSON, in the editor. At most one per
 * document. It belongs to no machine, since the hub keeps both documents.
 */
export interface JsonSettingsTab {
  kind: "json-settings";
  id: string;
  /** Hub document the tab edits. */
  name: UserDocumentName;
}

export type MainTab =
  | FileTab
  | CommitTab
  | GraphTab
  | ChangesTab
  | SettingsTab
  | OverviewTab
  | JsonSettingsTab;

/**
 * Tabs opened from one machine and session. Settings, the overview and the
 * settings files belong to none.
 */
export type MachineTab = FileTab | CommitTab | GraphTab | ChangesTab;

export function isMachineTab(tab: MainTab): tab is MachineTab {
  return tab.kind !== "settings" && tab.kind !== "overview" && tab.kind !== "json-settings";
}

/**
 * What a bulk close takes. `all` includes settings, the overview and graphs,
 * `diffs` includes commits. The terminal stays.
 */
export type CloseGroup = "all" | "diffs" | "files";

export const TERMINAL_TAB = "terminal";
export const SETTINGS_TAB = "settings";
export const OVERVIEW_TAB = "overview";
const MAX_TABS = 12;

export function fileTabId(tab: Pick<FileTab, "path" | "scope" | "machineId">): string {
  return scopedId(`${tab.scope ?? "file"}:${tab.path}`, tab.machineId);
}

export function commitTabId(hash: string, machine?: string): string {
  return scopedId(`commit:${hash}`, machine);
}

export function graphTabId(contextPath: string, machine?: string): string {
  return scopedId(`graph:${contextPath}`, machine);
}

export function changesTabId(contextPath: string, machine?: string): string {
  return scopedId(`changes:${contextPath}`, machine);
}

export function jsonSettingsTabId(name: UserDocumentName): string {
  return `json-settings:${name}`;
}

/** Tab label, the file name the hub keeps the document in. */
export function jsonSettingsTabLabel(name: UserDocumentName): string {
  return `${name}.json`;
}

function isUserDocumentName(value: unknown): value is UserDocumentName {
  return (USER_DOCUMENT_NAMES as readonly unknown[]).includes(value);
}

interface MainTabsStore {
  tabs: MainTab[];
  order: string[];
  setOrder: (order: string[]) => void;
  /** `TERMINAL_TAB` or a tab id. */
  active: string;
  openFile: (tab: Omit<FileTab, "id" | "kind">) => void;
  openCommit: (tab: Omit<CommitTab, "id" | "kind">) => void;
  /**
   * Fill in a subject the opener did not know. Never activates. Takes the
   * tab id, which carries the machine the tab was opened on. The machine
   * selected now can be another one.
   */
  nameCommit: (id: string, subject: string) => void;
  openChanges: (tab: Omit<ChangesTab, "id" | "kind">) => void;
  openGraph: (tab: Omit<GraphTab, "id" | "kind">) => void;
  openSettings: () => void;
  openOverview: () => void;
  /** Open or bring to front the JSON editor of a user document. */
  openJsonSettings: (name: UserDocumentName) => void;
  closeTab: (id: string) => void;
  closeTabs: (group: CloseGroup) => void;
  activate: (id: string) => void;
  showTerminal: () => void;
}

/**
 * Cut the strip down to `MAX_TABS`. The oldest file or commit goes first.
 * Graphs hold loaded pages and are where commits are opened from, and
 * settings, the overview and the settings files are single tabs, so those
 * go only when nothing else can. A tab in `keep` never goes.
 */
export function trimTabs(tabs: MainTab[], keep: ReadonlySet<string>): MainTab[] {
  if (tabs.length <= MAX_TABS) return tabs;
  const next = [...tabs];
  while (next.length > MAX_TABS) {
    let index = next.findIndex(
      (t) => (t.kind === "file" || t.kind === "commit" || t.kind === "changes") && !keep.has(t.id),
    );
    if (index < 0) index = next.findIndex((t) => !keep.has(t.id));
    next.splice(Math.max(index, 0), 1);
  }
  return next;
}

/**
 * Replace a tab in place, or append it. A full strip drops a tab as
 * `trimTabs` picks it, never the new tab or the one in front.
 */
function upsert(tabs: MainTab[], tab: MainTab, active: string): MainTab[] {
  const existing = tabs.findIndex((t) => t.id === tab.id);
  if (existing < 0) return trimTabs([...tabs, tab], new Set([tab.id, active]));
  const next = [...tabs];
  next[existing] = tab;
  return next;
}

export function inGroup(tab: MainTab, group: CloseGroup): boolean {
  if (group === "all") return true;
  if (tab.kind === "commit" || tab.kind === "changes") return group === "diffs";
  if (tab.kind !== "file") return false;
  return group === "diffs" ? !!tab.scope : !tab.scope;
}

function isMainTab(value: unknown): value is MainTab {
  const tab = value as
    | Partial<FileTab>
    | Partial<CommitTab>
    | Partial<GraphTab>
    | Partial<ChangesTab>
    | Partial<SettingsTab>
    | Partial<OverviewTab>
    | Partial<JsonSettingsTab>
    | null;
  if (tab?.kind === "settings") return tab.id === SETTINGS_TAB;
  if (tab?.kind === "overview") return tab.id === OVERVIEW_TAB;
  if (tab?.kind === "json-settings")
    return isUserDocumentName(tab.name) && tab.id === jsonSettingsTabId(tab.name);
  if (!tab) return false;
  const origin = tab as TabOrigin;
  if (
    (origin.machineId !== undefined &&
      (typeof origin.machineId !== "string" || !/^[a-zA-Z0-9_-]+$/.test(origin.machineId))) ||
    (origin.sessionName != null && typeof origin.sessionName !== "string")
  )
    return false;
  if (tab?.kind === "graph" || tab?.kind === "changes")
    return (
      typeof tab.paneId === "string" &&
      typeof tab.contextPath === "string" &&
      tab.contextPath.startsWith("/") &&
      tab.id === (tab.kind === "graph" ? graphTabId : changesTabId)(tab.contextPath, tab.machineId)
    );
  if (tab?.kind === "commit")
    return (
      typeof tab.paneId === "string" &&
      typeof tab.subject === "string" &&
      typeof tab.contextPath === "string" &&
      typeof tab.hash === "string" &&
      /^[0-9a-f]{40,64}$/.test(tab.hash) &&
      tab.id === commitTabId(tab.hash, tab.machineId)
    );
  return (
    tab?.kind === "file" &&
    typeof tab.paneId === "string" &&
    typeof tab.path === "string" &&
    tab.id === fileTabId(tab as FileTab)
  );
}

/** Keep well formed tabs only, and an active id that still names one. */
export function restoreTabs(persisted: unknown): Pick<MainTabsStore, "tabs" | "active" | "order"> {
  const state = persisted as Partial<MainTabsStore> | undefined;
  const keep = new Set(typeof state?.active === "string" ? [state.active] : []);
  const tabs = Array.isArray(state?.tabs) ? trimTabs(state.tabs.filter(isMainTab), keep) : [];
  const active = tabs.find((t) => t.id === state?.active)?.id ?? TERMINAL_TAB;
  const order = Array.isArray(state?.order)
    ? [...new Set(state.order.filter((id): id is string => typeof id === "string"))]
    : [];
  return { tabs, active, order };
}

/** Preserve saved positions, remove closed views and append new views. */
export function reconcileTabOrder(order: string[], visible: string[]): string[] {
  const remaining = new Set(visible);
  const next = order.filter((id) => remaining.delete(id));
  return [...next, ...remaining];
}

export function moveTabInOrder(
  order: string[],
  id: string,
  target: string,
  side: "before" | "after",
): string[] {
  if (id === target || !order.includes(id) || !order.includes(target)) return order;
  const next = order.filter((item) => item !== id);
  next.splice(next.indexOf(target) + (side === "after" ? 1 : 0), 0, id);
  return next;
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

export const tabStorage: StateStorage = {
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
      order: [],
      setOrder: (order) =>
        set((s) =>
          order.length === s.order.length && order.every((id, index) => id === s.order[index])
            ? s
            : { order },
        ),
      active: TERMINAL_TAB,
      openFile: (input) =>
        set((s) => {
          // Same file again: refresh what it points at, keep its place.
          const origin = { ...tabOrigin(), ...input };
          const id = fileTabId(origin);
          return {
            tabs: upsert(s.tabs, { ...origin, kind: "file", id }, s.active),
            active: id,
          };
        }),
      openCommit: (input) =>
        set((s) => {
          const origin = { ...tabOrigin(), ...input };
          const id = commitTabId(input.hash, origin.machineId);
          const known = s.tabs.find((t) => t.id === id);
          // A parent link knows no subject. Keep the one already shown.
          const subject = input.subject || (known?.kind === "commit" ? known.subject : "");
          return {
            tabs: upsert(s.tabs, { ...origin, subject, kind: "commit", id }, s.active),
            active: id,
          };
        }),
      nameCommit: (id, subject) =>
        set((s) => {
          const index = s.tabs.findIndex((t) => t.id === id);
          const tab = s.tabs[index];
          if (tab?.kind !== "commit" || tab.subject === subject) return s;
          const tabs = [...s.tabs];
          tabs[index] = { ...tab, subject };
          return { tabs };
        }),
      openChanges: (input) =>
        set((s) => {
          const origin = { ...tabOrigin(), ...input };
          const id = changesTabId(input.contextPath, origin.machineId);
          return {
            tabs: upsert(s.tabs, { ...origin, kind: "changes", id }, s.active),
            active: id,
          };
        }),
      openGraph: (input) =>
        set((s) => {
          const origin = { ...tabOrigin(), ...input };
          const id = graphTabId(input.contextPath, origin.machineId);
          return {
            tabs: upsert(s.tabs, { ...origin, kind: "graph", id }, s.active),
            active: id,
          };
        }),
      openSettings: () =>
        set((s) => ({
          tabs: upsert(s.tabs, { kind: "settings", id: SETTINGS_TAB }, s.active),
          active: SETTINGS_TAB,
        })),
      openOverview: () =>
        set((s) => ({
          tabs: upsert(s.tabs, { kind: "overview", id: OVERVIEW_TAB }, s.active),
          active: OVERVIEW_TAB,
        })),
      openJsonSettings: (name) =>
        set((s) => {
          const id = jsonSettingsTabId(name);
          return {
            tabs: upsert(s.tabs, { kind: "json-settings", id, name }, s.active),
            active: id,
          };
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
      closeTabs: (group) =>
        set((s) => {
          const tabs = s.tabs.filter((t) => !inGroup(t, group));
          if (tabs.length === s.tabs.length) return s;
          const index = s.tabs.findIndex((t) => t.id === s.active);
          const current = s.tabs[index];
          if (!current || !inGroup(current, group)) return { tabs };
          // The open tab went too. Land on the nearest one left after it, then
          // before it, then on the terminal.
          const kept = s.tabs.map((t) => !inGroup(t, group));
          const after = kept.indexOf(true, index + 1);
          const next = s.tabs[after >= 0 ? after : kept.lastIndexOf(true, index)];
          return { tabs, active: next?.id ?? TERMINAL_TAB };
        }),
      activate: (active) => set({ active }),
      showTerminal: () => set({ active: TERMINAL_TAB }),
    }),
    {
      name: "tmuxde-main-tabs",
      version: 1,
      storage: createJSONStorage(() => tabStorage),
      partialize: (state) => ({ tabs: state.tabs, active: state.active, order: state.order }),
      merge: (persisted, current) => ({ ...current, ...restoreTabs(persisted) }),
    },
  ),
);
