import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";
import { z } from "zod";
import { tabStorage } from "./main-tabs-store";
import type { RepoResult } from "@/protocol";

const ExplorerTree = z.enum(["files", "changes:staged", "changes:unstaged", "changes:untracked"]);
const TreeKey = z.tuple([
  z.string(),
  ExplorerTree,
  z.string().startsWith("/"),
  z.string().startsWith("/"),
]);
type ExplorerTree = z.infer<typeof ExplorerTree>;
type GitTree = Exclude<ExplorerTree, "files">;
type GitStatus = Extract<RepoResult, { kind: "status" }>;

export const MAX_EXPLORER_WORKDIRS = 50;

function directory(path: string): string {
  return path.replace(/\/+$/, "") || "/";
}

function parseTreeKey(key: string) {
  try {
    const result = TreeKey.safeParse(JSON.parse(key));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

function workdirKey([machine, , root, workdir]: z.infer<typeof TreeKey>): string {
  return JSON.stringify([machine, directory(root), directory(workdir)]);
}

/** Pane IDs and sockets change. Machine and absolute directories identify saved trees. */
export function explorerTreeKey(
  machine: string,
  tree: ExplorerTree,
  root: string,
  workdir: string,
): string {
  return JSON.stringify([machine, tree, directory(root), directory(workdir)]);
}

const SavedFolders = z.object({ folders: z.record(z.string(), z.array(z.string())) });
type FolderState = z.infer<typeof SavedFolders>["folders"];

/** Object order carries recency. Keep every explorer of a workdir together. */
function retainRecent(folders: FolderState, touched?: string): FolderState {
  const workdirs = new Map<string, Map<string, string[]>>();
  for (const [key, paths] of Object.entries(folders)) {
    const parts = parseTreeKey(key);
    if (!parts) continue;
    const context = workdirKey(parts);
    const trees = workdirs.get(context) ?? new Map<string, string[]>();
    const unique = [...new Set(paths)];
    trees.set(explorerTreeKey(...parts), unique.length === paths.length ? paths : unique);
    workdirs.delete(context);
    workdirs.set(context, trees);
  }
  const parts = touched ? parseTreeKey(touched) : null;
  const context = parts ? workdirKey(parts) : null;
  const current = context ? workdirs.get(context) : null;
  if (context && current) {
    workdirs.delete(context);
    workdirs.set(context, current);
  }
  return Object.fromEntries(
    [...workdirs.values()].slice(-MAX_EXPLORER_WORKDIRS).flatMap((trees) => [...trees]),
  );
}

function restoreFolders(saved: unknown): { folders: FolderState } {
  const result = SavedFolders.safeParse(saved);
  return { folders: result.success ? retainRecent(result.data.folders) : {} };
}

interface ExplorerStore {
  /** Expanded file folders or collapsed change folders, keyed by tree context. */
  folders: Record<string, string[]>;
  updateFolders: (
    key: string,
    update: (previous: ReadonlySet<string> | undefined) => ReadonlySet<string>,
  ) => void;
  touchTree: (key: string) => void;
  reconcileGit: (machine: string, status: GitStatus) => void;
}

const storage: StateStorage = {
  getItem: (key) => {
    try {
      return tabStorage.getItem(key);
    } catch {
      return null;
    }
  },
  setItem: (key, value) => {
    try {
      tabStorage.setItem(key, value);
    } catch {
      // Full or blocked storage leaves folder state available for this visit.
    }
  },
  removeItem: (key) => {
    try {
      tabStorage.removeItem(key);
    } catch {
      // Storage may be unavailable.
    }
  },
};

export const useExplorerStore = create<ExplorerStore>()(
  persist(
    (set, get) => ({
      folders: {},
      updateFolders: (key, update) =>
        set((state) => {
          const previous = state.folders[key];
          const next = update(previous ? new Set(previous) : undefined);
          return { folders: retainRecent({ ...state.folders, [key]: [...next] }, key) };
        }),
      touchTree: (key) => {
        const previous = get().folders;
        const folders = retainRecent(previous, key);
        const before = Object.keys(previous);
        const after = Object.keys(folders);
        if (
          before.length !== after.length ||
          after.some((name, index) => name !== before[index] || folders[name] !== previous[name])
        )
          set({ folders });
      },
      reconcileGit: (machine, status) => {
        if (!status.root || status.truncated) return;
        const valid: Record<GitTree, Set<string>> = {
          "changes:staged": new Set(),
          "changes:unstaged": new Set(),
          "changes:untracked": new Set(),
        };
        const changed = (code: string) => ![" ", "?", "!"].includes(code);
        for (const entry of status.entries) {
          const groups: GitTree[] = [];
          if (changed(entry.index)) groups.push("changes:staged");
          if (changed(entry.worktree)) groups.push("changes:unstaged");
          if (entry.index === "?" || entry.worktree === "?") groups.push("changes:untracked");
          let end = entry.path.lastIndexOf("/");
          while (end > 0) {
            for (const group of groups) valid[group].add(entry.path.slice(0, end));
            end = entry.path.lastIndexOf("/", end - 1);
          }
        }
        const previous = get().folders;
        const folders = { ...previous };
        let updated = false;
        for (const [key, paths] of Object.entries(previous)) {
          const parts = parseTreeKey(key);
          if (!parts) continue;
          const [owner, tree, root] = parts;
          if (owner !== machine || tree === "files" || directory(root) !== directory(status.root))
            continue;
          const next = paths.filter((path) => valid[tree].has(path));
          if (!next.length) {
            delete folders[key];
            updated = true;
          } else if (next.length !== paths.length) {
            folders[key] = next;
            updated = true;
          }
        }
        if (updated) set({ folders });
      },
    }),
    {
      name: "tmuxde-explorer-folders",
      version: 1,
      migrate: restoreFolders,
      storage: createJSONStorage(() => storage),
      partialize: (state) => ({ folders: state.folders }),
      merge: (saved, current) => ({ ...current, ...restoreFolders(saved) }),
    },
  ),
);
