import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setEnrolled } from "@/features/lock/unlocked";
import { explorerTreeKey, MAX_EXPLORER_WORKDIRS, useExplorerStore } from "./explorer-store";
import type { RepoResult } from "@/protocol";

const STORAGE_KEY = "tmuxde-explorer-folders";
const fileKey = (machine = "local", root = "/repo", workdir = root) =>
  explorerTreeKey(machine, "files", root, workdir);
const gitTrees = ["changes:staged", "changes:unstaged", "changes:untracked"] as const;
const gitStatus = (
  entries: Extract<RepoResult, { kind: "status" }>["entries"] = [],
): Extract<RepoResult, { kind: "status" }> => ({
  kind: "status",
  root: "/repo",
  branch: "main",
  entries,
  truncated: false,
});

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => {
      values.delete(key);
    },
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
}

let local: Storage;
let session: Storage;
beforeEach(() => {
  setEnrolled(false);
  local = memoryStorage();
  session = memoryStorage();
  vi.stubGlobal("window", { localStorage: local, sessionStorage: session });
  useExplorerStore.setState({ folders: {} });
});
afterEach(() => {
  setEnrolled(false);
  vi.unstubAllGlobals();
  useExplorerStore.setState({ folders: {} });
});

describe("explorer retention", () => {
  it("keeps at most 50 workdirs and evicts their explorer groups together", () => {
    const { updateFolders } = useExplorerStore.getState();
    for (let index = 0; index <= MAX_EXPLORER_WORKDIRS; index++) {
      for (const tree of ["files", ...gitTrees] as const)
        updateFolders(
          explorerTreeKey("local", tree, "/repo", `/repo/${index}`),
          () => new Set(["folder"]),
        );
    }
    const { folders } = useExplorerStore.getState();
    expect(Object.keys(folders)).toHaveLength(MAX_EXPLORER_WORKDIRS * 4);
    for (const tree of ["files", ...gitTrees] as const) {
      expect(folders[explorerTreeKey("local", tree, "/repo", "/repo/0")]).toBeUndefined();
      expect(folders[explorerTreeKey("local", tree, "/repo", "/repo/1")]).toEqual(["folder"]);
      expect(
        folders[explorerTreeKey("local", tree, "/repo", `/repo/${MAX_EXPLORER_WORKDIRS}`)],
      ).toEqual(["folder"]);
    }
  });

  it("a visit refreshes workdir recency even when only another explorer has saved state", async () => {
    const { updateFolders, touchTree } = useExplorerStore.getState();
    const first = explorerTreeKey("local", "changes:staged", "/repo", "/repo/0");
    updateFolders(first, () => new Set(["src"]));
    for (let index = 1; index < MAX_EXPLORER_WORKDIRS; index++)
      updateFolders(fileKey("local", "/repo", `/repo/${index}`), () => new Set());
    touchTree(fileKey("local", "/repo", "/repo/0"));
    await useExplorerStore.persist.rehydrate();
    updateFolders(fileKey("local", "/repo", "/repo/new"), () => new Set());
    expect(useExplorerStore.getState().folders[first]).toEqual(["src"]);
    expect(
      useExplorerStore.getState().folders[fileKey("local", "/repo", "/repo/1")],
    ).toBeUndefined();
  });

  it("writes refresh recency without losing other groups of that workdir", () => {
    const { updateFolders } = useExplorerStore.getState();
    updateFolders(fileKey(), () => new Set(["/repo/src"]));
    const staged = explorerTreeKey("local", "changes:staged", "/repo", "/repo");
    updateFolders(staged, () => new Set(["src"]));
    for (let index = 1; index < MAX_EXPLORER_WORKDIRS; index++)
      updateFolders(fileKey("local", `/other-${index}`), () => new Set());
    updateFolders(staged, (previous) => new Set([...previous!, "docs"]));
    updateFolders(fileKey("local", "/new"), () => new Set());
    expect(useExplorerStore.getState().folders[fileKey()]).toEqual(["/repo/src"]);
    expect(useExplorerStore.getState().folders[staged]).toEqual(["src", "docs"]);
    expect(useExplorerStore.getState().folders[fileKey("local", "/other-1")]).toBeUndefined();
  });

  it("does not write storage for visits with no preferences or unchanged recency", () => {
    const { updateFolders, touchTree } = useExplorerStore.getState();
    updateFolders(fileKey(), () => new Set());
    const write = vi.spyOn(local, "setItem");
    const before = useExplorerStore.getState();
    touchTree(fileKey("local", "/missing"));
    touchTree(fileKey());
    expect(useExplorerStore.getState()).toBe(before);
    expect(write).not.toHaveBeenCalled();
  });

  it("trims and rewrites legacy storage during migration", async () => {
    const folders: Record<string, string[]> = { "not a tree key": ["ignored"] };
    for (let index = 0; index < MAX_EXPLORER_WORKDIRS + 5; index++)
      folders[fileKey("local", `/repo-${index}`)] = ["src", "src"];
    local.setItem(STORAGE_KEY, JSON.stringify({ state: { folders }, version: 0 }));
    await useExplorerStore.persist.rehydrate();
    const restored = useExplorerStore.getState().folders;
    expect(Object.keys(restored)).toHaveLength(MAX_EXPLORER_WORKDIRS);
    expect(restored[fileKey("local", "/repo-4")]).toBeUndefined();
    expect(restored[fileKey("local", "/repo-5")]).toEqual(["src"]);
    const saved = JSON.parse(local.getItem(STORAGE_KEY)!);
    expect(saved.version).toBe(1);
    expect(saved.state.folders).toEqual(restored);
  });
});

describe("Git folder cleanup", () => {
  it("prunes group layouts across cached workdirs without touching other machines, repositories or files", () => {
    const { updateFolders, reconcileGit } = useExplorerStore.getState();
    const paths = ["src", "src/deep", "docs", "new", "both", "obsolete"];
    for (const workdir of ["/repo", "/repo/src"])
      for (const tree of gitTrees)
        updateFolders(explorerTreeKey("local", tree, "/repo", workdir), () => new Set(paths));
    const otherMachine = explorerTreeKey("beta", "changes:staged", "/repo", "/repo");
    const otherRoot = explorerTreeKey("local", "changes:staged", "/repo-extra", "/repo-extra");
    for (const key of [otherMachine, otherRoot, fileKey()])
      updateFolders(key, () => new Set(paths));
    reconcileGit(
      "local",
      gitStatus([
        { path: "src/deep/current.ts", index: "M", worktree: " " },
        { path: "docs/current.md", index: " ", worktree: "M" },
        { path: "new/item.ts", index: "?", worktree: "?" },
        { path: "both/file.ts", index: "M", worktree: "M" },
      ]),
    );
    const { folders } = useExplorerStore.getState();
    for (const workdir of ["/repo", "/repo/src"]) {
      expect(folders[explorerTreeKey("local", "changes:staged", "/repo", workdir)]).toEqual([
        "src",
        "src/deep",
        "both",
      ]);
      expect(folders[explorerTreeKey("local", "changes:unstaged", "/repo", workdir)]).toEqual([
        "docs",
        "both",
      ]);
      expect(folders[explorerTreeKey("local", "changes:untracked", "/repo", workdir)]).toEqual([
        "new",
      ]);
    }
    for (const key of [otherMachine, otherRoot, fileKey()]) expect(folders[key]).toEqual(paths);
  });

  it("clean status deletes every Git group of matching repository, including empty saved groups", () => {
    const { updateFolders, reconcileGit } = useExplorerStore.getState();
    for (const workdir of ["/repo", "/repo/src"])
      for (const tree of gitTrees)
        updateFolders(
          explorerTreeKey("local", tree, "/repo", workdir),
          () => new Set(tree === "changes:staged" ? [] : ["src"]),
        );
    updateFolders(fileKey(), () => new Set(["/repo/src"]));
    reconcileGit("local", gitStatus());
    expect(useExplorerStore.getState().folders).toEqual({ [fileKey()]: ["/repo/src"] });
    expect(JSON.parse(local.getItem(STORAGE_KEY)!).state.folders).toEqual({
      [fileKey()]: ["/repo/src"],
    });
  });

  it.each([gitStatus(), gitStatus([{ path: "other/file", index: "M", worktree: " " }])])(
    "does not prune truncated status %j",
    (status) => {
      const key = explorerTreeKey("local", "changes:staged", "/repo", "/repo");
      useExplorerStore.getState().updateFolders(key, () => new Set(["src"]));
      const before = useExplorerStore.getState();
      useExplorerStore.getState().reconcileGit("local", { ...status, truncated: true });
      expect(useExplorerStore.getState()).toBe(before);
    },
  );

  it("does not treat a non-repository response as a clean repository", () => {
    const key = explorerTreeKey("local", "changes:staged", "/repo", "/repo");
    useExplorerStore.getState().updateFolders(key, () => new Set(["src"]));
    const before = useExplorerStore.getState();
    useExplorerStore.getState().reconcileGit("local", { ...gitStatus(), root: null });
    expect(useExplorerStore.getState()).toBe(before);
  });

  it("removes obsolete folder state when remaining changes are root files", () => {
    const key = explorerTreeKey("local", "changes:unstaged", "/repo", "/repo");
    useExplorerStore.getState().updateFolders(key, () => new Set(["src"]));
    useExplorerStore
      .getState()
      .reconcileGit("local", gitStatus([{ path: "root.ts", index: " ", worktree: "M" }]));
    expect(useExplorerStore.getState().folders).toEqual({});
  });

  it("does not notify or serialize when complete status retains same folders", () => {
    const key = explorerTreeKey("local", "changes:staged", "/repo", "/repo");
    useExplorerStore.getState().updateFolders(key, () => new Set(["src"]));
    const write = vi.spyOn(local, "setItem");
    const before = useExplorerStore.getState();
    useExplorerStore
      .getState()
      .reconcileGit("local", gitStatus([{ path: "src/file", index: "M", worktree: " " }]));
    expect(useExplorerStore.getState()).toBe(before);
    expect(write).not.toHaveBeenCalled();
  });
});
describe("explorer folder state", () => {
  it("isolates machines, repositories, workdirs, explorers and Git groups", () => {
    const keys = [
      fileKey(),
      fileKey("beta"),
      fileKey("local", "/other"),
      fileKey("local", "/repo", "/repo/src"),
      explorerTreeKey("local", "changes:staged", "/repo", "/repo"),
      explorerTreeKey("local", "changes:unstaged", "/repo", "/repo"),
      explorerTreeKey("local", "changes:untracked", "/repo", "/repo"),
    ];
    expect(new Set(keys).size).toBe(keys.length);
    const { updateFolders } = useExplorerStore.getState();
    keys.forEach((key, index) => updateFolders(key, () => new Set([`folder-${index}`])));
    keys.forEach((key, index) =>
      expect(useExplorerStore.getState().folders[key]).toEqual([`folder-${index}`]),
    );
    updateFolders(keys[0]!, () => new Set());
    expect(useExplorerStore.getState().folders[keys[1]!]).toEqual(["folder-1"]);
  });

  it("normalizes trailing separators without path-prefix collisions", () => {
    expect(fileKey("local", "/repo/", "/repo/src/")).toBe(fileKey("local", "/repo", "/repo/src"));
    expect(fileKey("local", "/", "/")).toBe(fileKey("local", "//", "//"));
    expect(fileKey("local", "/repo", "/repo/src")).not.toBe(
      fileKey("local", "/repo", "/repo/src-extra"),
    );
  });

  it("distinguishes a saved collapse-all from an unvisited context", () => {
    const { updateFolders } = useExplorerStore.getState();
    const before = vi.fn(() => new Set<string>());
    updateFolders(fileKey(), before);
    expect(before).toHaveBeenCalledExactlyOnceWith(undefined);
    const revisit = vi.fn((previous) => previous ?? new Set(["default-folder"]));
    updateFolders(fileKey(), revisit);
    expect(revisit).toHaveBeenCalledExactlyOnceWith(new Set());
    expect(useExplorerStore.getState().folders[fileKey()]).toEqual([]);
  });

  it("applies updates to latest saved state without mutating earlier snapshots", () => {
    const { updateFolders } = useExplorerStore.getState();
    updateFolders(fileKey(), () => new Set(["/repo/a"]));
    const snapshot = useExplorerStore.getState().folders;
    updateFolders(fileKey(), (previous) => new Set([...previous!, "/repo/b"]));
    updateFolders(fileKey(), (previous) => new Set([...previous!, "/repo/c"]));
    expect(useExplorerStore.getState().folders[fileKey()]).toEqual([
      "/repo/a",
      "/repo/b",
      "/repo/c",
    ]);
    expect(snapshot[fileKey()]).toEqual(["/repo/a"]);
  });

  it("updates a captured workdir after switching to another workdir", () => {
    const { updateFolders } = useExplorerStore.getState();
    const first = fileKey();
    const second = fileKey("local", "/other");
    updateFolders(first, () => new Set(["/repo/from", "/repo/from/nested"]));
    updateFolders(second, () => new Set(["/other/keep"]));
    updateFolders(
      first,
      (previous) => new Set([...previous!].map((path) => path.replace("/repo/from", "/repo/to"))),
    );
    expect(useExplorerStore.getState().folders[first]).toEqual(["/repo/to", "/repo/to/nested"]);
    expect(useExplorerStore.getState().folders[second]).toEqual(["/other/keep"]);
  });

  it("restores saved folders after hydration, including empty contexts", async () => {
    const folders = { [fileKey()]: ["/repo/src"], [fileKey("beta")]: [] };
    local.setItem(STORAGE_KEY, JSON.stringify({ state: { folders }, version: 0 }));
    await useExplorerStore.persist.rehydrate();
    expect(useExplorerStore.getState().folders).toEqual(folders);
    expect(typeof useExplorerStore.getState().updateFolders).toBe("function");
  });

  it.each([null, { folders: [] }, { folders: { bad: [1] } }, { folders: { bad: "open" } }])(
    "ignores malformed persisted state %j",
    async (state) => {
      local.setItem(STORAGE_KEY, JSON.stringify({ state, version: 0 }));
      await useExplorerStore.persist.rehydrate();
      expect(useExplorerStore.getState().folders).toEqual({});
    },
  );

  it("uses lock-aware storage and removes old local copy on next write", async () => {
    useExplorerStore.getState().updateFolders(fileKey(), () => new Set(["/repo/src"]));
    expect(local.getItem(STORAGE_KEY)).not.toBeNull();
    setEnrolled(true);
    useExplorerStore.getState().updateFolders(fileKey("beta"), () => new Set(["/repo/beta"]));
    expect(local.getItem(STORAGE_KEY)).toBeNull();
    expect(session.getItem(STORAGE_KEY)).not.toBeNull();
    await useExplorerStore.persist.rehydrate();
    expect(useExplorerStore.getState().folders[fileKey()]).toEqual(["/repo/src"]);
    expect(useExplorerStore.getState().folders[fileKey("beta")]).toEqual(["/repo/beta"]);
  });

  it("keeps in-memory folder state when storage is full", () => {
    vi.spyOn(local, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    expect(() =>
      useExplorerStore.getState().updateFolders(fileKey(), () => new Set(["/repo/src"])),
    ).not.toThrow();
    expect(useExplorerStore.getState().folders[fileKey()]).toEqual(["/repo/src"]);
  });

  it("keeps in-memory folder state when browser blocks storage access", () => {
    vi.stubGlobal("window", {
      get localStorage() {
        throw new Error("SecurityError");
      },
      get sessionStorage() {
        throw new Error("SecurityError");
      },
    });
    expect(() =>
      useExplorerStore.getState().updateFolders(fileKey(), () => new Set(["/repo/src"])),
    ).not.toThrow();
    expect(useExplorerStore.getState().folders[fileKey()]).toEqual(["/repo/src"]);
  });
});
