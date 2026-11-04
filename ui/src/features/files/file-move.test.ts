import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RepositoryClient } from "@/features/repository/repository-request";
import { fileTabId, useMainTabsStore, type FileTab } from "@/features/workspace/main-tabs-store";
import { draftKey, editDraft, openDraft, saveDraft, useFileDrafts } from "./file-drafts";
import { useFileStore } from "./file-store";
import { fileOperation } from "./file-operation";
import { moveDestination, moveFileEntry } from "./file-move";

vi.mock("./file-operation", () => ({ fileOperation: vi.fn() }));
const client: RepositoryClient = {
  status: "connected",
  send: vi.fn(),
  onMessage: () => () => {},
  onStatusChange: () => () => {},
};

function draft(machine: string, path: string) {
  openDraft(machine, path);
  const key = draftKey(machine, path);
  useFileDrafts.setState((state) => ({
    drafts: {
      ...state.drafts,
      [key]: {
        ...state.drafts[key]!,
        online: true,
        needsCheck: false,
        base: { content: "base", writable: true, revision: "a".repeat(64) },
        content: "base",
      },
    },
  }));
  editDraft(key, "unsaved text");
  const tab: FileTab = {
    kind: "file",
    path,
    machineId: machine,
    id: fileTabId({ path, machineId: machine }),
    paneId: "%0",
  };
  useMainTabsStore.setState((state) => ({
    tabs: [...state.tabs, tab],
    active: tab.id,
    order: [...state.order, tab.id],
  }));
  return key;
}

beforeEach(() => {
  useMainTabsStore.setState({ tabs: [], active: "terminal", order: [] });
  useFileDrafts.setState({ drafts: {} });
  useFileStore.setState({ editorFile: null });
  vi.clearAllMocks();
  vi.mocked(fileOperation).mockResolvedValue();
});

describe("file moves", () => {
  it.each([
    ["/work/file", "/work"],
    ["/work/folder", "/work/folder"],
    ["/work/folder", "/work/folder/child"],
    ["/work/file", "relative"],
    ["/work/file", "/work/../other"],
  ])("rejects move from %s into %s", (from, directory) => {
    expect(() => moveDestination(from, directory)).toThrow();
  });

  it("joins names at filesystem root and keeps prefix siblings distinct", () => {
    expect(moveDestination("/work/file", "/")).toBe("/file");
    expect(moveDestination("/work/a", "/work/ab/")).toBe("/work/ab/a");
  });

  it("moves folder drafts and tab order on one machine while preserving model identity", async () => {
    const otherKey = draft("beta", "/work/folder/note.txt");
    const first = draft("alpha", "/work/folder/note.txt");
    const second = draft("alpha", "/work/folder/nested/other.txt");
    const prefix = draft("alpha", "/work/folder-extra/keep.txt");
    const old = useFileDrafts.getState().drafts[first]!;
    useMainTabsStore.setState({ active: fileTabId({ path: old.path, machineId: "alpha" }) });
    await moveFileEntry(client, "alpha", "/work/folder", "/target", new AbortController().signal);
    const state = useFileDrafts.getState().drafts;
    expect(state[first]).toBeUndefined();
    expect(state[second]).toBeUndefined();
    expect(state[draftKey("alpha", "/target/folder/note.txt")]).toMatchObject({
      content: "unsaved text",
      modelKey: old.modelKey,
      moving: false,
      needsCheck: true,
    });
    expect(state[otherKey]?.path).toBe("/work/folder/note.txt");
    expect(state[prefix]?.path).toBe("/work/folder-extra/keep.txt");
    const tabs = useMainTabsStore.getState();
    expect(tabs.active).toBe("alpha:file:/target/folder/note.txt");
    expect(tabs.order).toContain(tabs.active);
    expect(tabs.order).not.toContain("alpha:file:/work/folder/note.txt");
    expect(fileOperation).toHaveBeenCalledWith(
      client,
      {
        type: "file:rename",
        oldPath: "/work/folder",
        newPath: "/target/folder",
        noReplace: true,
      },
      expect.any(AbortSignal),
    );
    openDraft("alpha", old.path);
    expect(useFileDrafts.getState().drafts[first]?.modelKey).not.toBe(old.modelKey);
  });

  it("blocks saves during move and preserves original path after failure", async () => {
    const key = draft("alpha", "/work/note.txt");
    let rejectMove!: (error: Error) => void;
    vi.mocked(fileOperation).mockImplementation(
      () =>
        new Promise((_, reject) => {
          rejectMove = reject;
        }),
    );
    const pending = moveFileEntry(
      client,
      "alpha",
      "/work/note.txt",
      "/target",
      new AbortController().signal,
    );
    expect(useFileDrafts.getState().drafts[key]?.moving).toBe(true);
    await saveDraft(key, client);
    expect(client.send).not.toHaveBeenCalled();
    rejectMove(new Error("File exists"));
    await expect(pending).rejects.toThrow("File exists");
    expect(useFileDrafts.getState().drafts[key]).toMatchObject({
      moving: false,
      content: "unsaved text",
      needsCheck: true,
    });
    expect(useMainTabsStore.getState().tabs[0]).toMatchObject({ path: "/work/note.txt" });
  });

  it("refuses unresolved saves and destination drafts", async () => {
    const key = draft("alpha", "/work/note.txt");
    useFileDrafts.setState((state) => ({
      drafts: { ...state.drafts, [key]: { ...state.drafts[key]!, pending: "unconfirmed" } },
    }));
    await expect(
      moveFileEntry(client, "alpha", "/work/note.txt", "/target", new AbortController().signal),
    ).rejects.toThrow("saves to finish");
    expect(fileOperation).not.toHaveBeenCalled();
    draft("alpha", "/target/note.txt");
    await expect(
      moveFileEntry(client, "alpha", "/work/note.txt", "/target", new AbortController().signal),
    ).rejects.toThrow("destination file tabs");
  });

  it("keeps drafts opened inside a folder while its move is pending", async () => {
    let resolveMove!: () => void;
    vi.mocked(fileOperation).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveMove = resolve;
        }),
    );
    const pending = moveFileEntry(
      client,
      "alpha",
      "/work/folder",
      "/target",
      new AbortController().signal,
    );
    const key = draft("alpha", "/work/folder/opened-later.txt");
    const modelKey = useFileDrafts.getState().drafts[key]!.modelKey;
    resolveMove();
    await pending;
    expect(useFileDrafts.getState().drafts[key]).toBeUndefined();
    expect(
      useFileDrafts.getState().drafts[draftKey("alpha", "/target/folder/opened-later.txt")],
    ).toMatchObject({
      content: "unsaved text",
      modelKey,
      moving: false,
      needsCheck: true,
    });
  });
});
