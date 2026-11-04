import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerMessage } from "@/protocol";
import type { RepositoryClient } from "@/features/repository/repository-request";
import { fileTabId, useMainTabsStore, type FileTab } from "@/features/workspace/main-tabs-store";
import { draftKey, editDraft, openDraft, useFileDrafts } from "./file-drafts";
import { useFileStore } from "./file-store";
import { deleteFileEntry } from "./file-delete";

function connection() {
  const messages = new Set<(message: ServerMessage) => void>();
  const statuses = new Set<Parameters<RepositoryClient["onStatusChange"]>[0]>();
  const client: RepositoryClient = {
    status: "connected",
    send: vi.fn(),
    onMessage: (handler) => {
      messages.add(handler);
      return () => {
        messages.delete(handler);
      };
    },
    onStatusChange: (handler) => {
      statuses.add(handler);
      return () => {
        statuses.delete(handler);
      };
    },
  };
  return {
    client,
    messages,
    statuses,
    reply: (path: string, success = true) => {
      for (const handler of messages)
        handler({
          type: "file:op:result",
          op: "delete",
          path,
          success,
          error: success ? undefined : "Access denied",
        });
    },
  };
}

function open(machine: string, path: string) {
  openDraft(machine, path);
  const key = draftKey(machine, path);
  useFileDrafts.setState((state) => ({
    drafts: {
      ...state.drafts,
      [key]: {
        ...state.drafts[key]!,
        content: "base",
        base: { content: "base", writable: true, revision: "a".repeat(64) },
      },
    },
  }));
  const tab: FileTab = {
    kind: "file",
    path,
    machineId: machine,
    id: fileTabId({ path, machineId: machine }),
    paneId: "%0",
  };
  useMainTabsStore.setState((state) => ({
    tabs: [...state.tabs, tab],
    order: [...state.order, tab.id],
    active: tab.id,
  }));
  return key;
}

beforeEach(() => {
  useMainTabsStore.setState({ tabs: [], active: "terminal", order: [] });
  useFileDrafts.setState({ drafts: {} });
  useFileStore.setState({ editorFile: null });
});

describe("file deletion", () => {
  it("closes confirmed subtree tabs only on target machine", async () => {
    const fake = connection();
    const other = open("beta", "/work/folder/note.txt");
    const prefix = open("alpha", "/work/folder-extra/note.txt");
    const nested = open("alpha", "/work/folder/nested/note.txt");
    const pending = deleteFileEntry(
      fake.client,
      "alpha",
      "/work/folder",
      new AbortController().signal,
    );
    fake.reply("/work/other");
    expect(useFileDrafts.getState().drafts[nested]).toBeDefined();
    fake.reply("/work/folder");
    await pending;
    expect(fake.client.send).toHaveBeenCalledExactlyOnceWith({
      type: "file:delete",
      path: "/work/folder",
    });
    expect(useFileDrafts.getState().drafts[nested]).toBeUndefined();
    expect(useFileDrafts.getState().drafts[other]).toBeDefined();
    expect(useFileDrafts.getState().drafts[prefix]).toBeDefined();
    const state = useMainTabsStore.getState();
    expect(state.tabs).toHaveLength(2);
    expect(state.order).toEqual(state.tabs.map((tab) => tab.id));
    expect(state.active).toBe(state.tabs[1]!.id);
    expect(fake.messages.size + fake.statuses.size).toBe(0);
  });

  it.each(["dirty", "saving", "moving", "pending"])(
    "protects %s descendant drafts before sending",
    async (kind) => {
      const fake = connection();
      const key = open("alpha", "/work/folder/note.txt");
      if (kind === "dirty") editDraft(key, "unsaved");
      else
        useFileDrafts.setState((state) => ({
          drafts: {
            ...state.drafts,
            [key]: { ...state.drafts[key]!, [kind]: kind === "pending" ? "unconfirmed" : true },
          },
        }));
      await expect(
        deleteFileEntry(fake.client, "alpha", "/work/folder", new AbortController().signal),
      ).rejects.toThrow("Save or close");
      expect(fake.client.send).not.toHaveBeenCalled();
    },
  );

  it("keeps edits made while deletion is pending", async () => {
    const fake = connection();
    const key = open("alpha", "/work/note.txt");
    const pending = deleteFileEntry(
      fake.client,
      "alpha",
      "/work/note.txt",
      new AbortController().signal,
    );
    editDraft(key, "keep this text");
    fake.reply("/work/note.txt");
    await pending;
    expect(useMainTabsStore.getState().tabs).toHaveLength(1);
    expect(useFileDrafts.getState().drafts[key]?.content).toBe("keep this text");
  });

  it.each(["rejected", "disconnected", "aborted"])(
    "keeps tabs after %s deletion without replay",
    async (failure) => {
      const fake = connection();
      const key = open("alpha", "/work/note.txt");
      const controller = new AbortController();
      const pending = deleteFileEntry(fake.client, "alpha", "/work/note.txt", controller.signal);
      if (failure === "rejected") fake.reply("/work/note.txt", false);
      else if (failure === "aborted") controller.abort();
      else for (const handler of fake.statuses) handler("reconnecting");
      await expect(pending).rejects.toThrow();
      for (const handler of fake.statuses) handler("connected");
      expect(fake.client.send).toHaveBeenCalledTimes(1);
      expect(fake.messages.size + fake.statuses.size).toBe(0);
      expect(useMainTabsStore.getState().tabs).toHaveLength(1);
      expect(useFileDrafts.getState().drafts[key]).toBeDefined();
    },
  );
});
