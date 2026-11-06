import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientMessage, ServerMessage } from "@/protocol";
import { setMachineId } from "@/features/connection/machine-context";
import { useConnectionStore } from "@/features/connection/connection-store";
import { useFileDrafts, openDraft, editDraft, draftKey } from "@/features/files/file-drafts";
import { useFileStore } from "@/features/files/file-store";
import type { RepositoryClient } from "./repository-request";
import { mutateChanges, type ChangeTarget } from "./change-actions";

function connection() {
  const messages = new Set<(message: ServerMessage) => void>();
  const statuses = new Set<Parameters<RepositoryClient["onStatusChange"]>[0]>();
  const sent: ClientMessage[] = [];
  const client: RepositoryClient = {
    status: "connected",
    send: (message) => {
      sent.push(message);
    },
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
  const reply = (error?: string) => {
    const request = sent.at(-1);
    if (request?.type !== "repo:request") throw new Error("Missing request");
    for (const handler of messages)
      handler({
        type: "repo:result",
        requestId: request.requestId,
        result: error
          ? { kind: "error", message: error }
          : { kind: "status", root: "/repo", branch: "main", entries: [], truncated: false },
      });
  };
  return { client, sent, reply, messages, statuses };
}

function target(client: RepositoryClient): ChangeTarget {
  return {
    client,
    machine: "alpha",
    paneId: "%1",
    root: "/repo",
    workdir: "/repo/src",
    path: "src",
    scope: "unstaged",
    entries: [
      { path: "src/a.ts", index: " ", worktree: "M" },
      { path: "src/b.ts", index: " ", worktree: "M" },
    ],
  };
}

function unsaved(path: string, machine = "alpha") {
  openDraft(machine, path);
  const key = draftKey(machine, path);
  useFileDrafts.setState((s) => ({
    drafts: {
      ...s.drafts,
      [key]: {
        ...s.drafts[key]!,
        base: { content: "base", revision: "a".repeat(64), writable: true },
        content: "base",
      },
    },
  }));
  editDraft(key, "unsaved");
}

beforeEach(() => {
  setMachineId("alpha");
  useFileDrafts.setState({ drafts: {} });
  useFileStore.setState({ editorFile: null });
  useConnectionStore.setState({ capabilities: null });
});

afterEach(() => {
  setMachineId(null);
  useConnectionStore.setState({ capabilities: null });
});

describe("changed file mutations", () => {
  it("preflights every file before sending first mutation", async () => {
    const fake = connection();
    unsaved("/repo/src/b.ts");
    await expect(
      mutateChanges(target(fake.client), "discard", new AbortController().signal, vi.fn()),
    ).rejects.toThrow("Save or close");
    expect(fake.sent).toEqual([]);
  });

  it("sends selected files sequentially with captured root and scope", async () => {
    const fake = connection();
    const progress = vi.fn();
    const promise = mutateChanges(
      target(fake.client),
      "stage",
      new AbortController().signal,
      progress,
    );
    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0]).toMatchObject({
      action: "stage",
      path: "/repo",
      file: "src/a.ts",
      scope: "unstaged",
    });
    fake.reply();
    await vi.waitFor(() => expect(fake.sent).toHaveLength(2));
    expect(fake.sent[1]).toMatchObject({ file: "src/b.ts", path: "/repo" });
    fake.reply();
    await promise;
    expect(progress.mock.calls).toEqual([[1], [2]]);
    expect(fake.messages.size).toBe(0);
    expect(fake.statuses.size).toBe(0);
  });

  it("stops remaining files after server refusal", async () => {
    const fake = connection();
    const promise = mutateChanges(
      target(fake.client),
      "stage",
      new AbortController().signal,
      vi.fn(),
    );
    const assertion = expect(promise).rejects.toThrow("Access denied");
    fake.reply("Access denied");
    await assertion;
    expect(fake.sent).toHaveLength(1);
  });

  it("disconnect rejects in-flight request and never replays remaining files", async () => {
    const fake = connection();
    const promise = mutateChanges(
      target(fake.client),
      "stage",
      new AbortController().signal,
      vi.fn(),
    );
    const assertion = expect(promise).rejects.toThrow("Connection lost");
    for (const listener of fake.statuses) listener("disconnected");
    await assertion;
    expect(fake.sent).toHaveLength(1);
    expect(fake.messages.size).toBe(0);
  });

  it("aborts remaining files on workspace change", async () => {
    const fake = connection();
    const controller = new AbortController();
    const promise = mutateChanges(target(fake.client), "stage", controller.signal, vi.fn());
    const assertion = expect(promise).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await assertion;
    expect(fake.sent).toHaveLength(1);
  });

  it("rechecks draft protection between files", async () => {
    const fake = connection();
    const promise = mutateChanges(
      target(fake.client),
      "discard",
      new AbortController().signal,
      () => unsaved("/repo/src/b.ts"),
    );
    const assertion = expect(promise).rejects.toThrow("Save or close");
    fake.reply();
    await assertion;
    expect(fake.sent).toHaveLength(1);
  });

  it("rejects old machine and revoked file permissions before sending", async () => {
    const fake = connection();
    setMachineId("beta");
    await expect(
      mutateChanges(target(fake.client), "stage", new AbortController().signal, vi.fn()),
    ).rejects.toThrow("machine changed");
    setMachineId("alpha");
    useConnectionStore.setState({ capabilities: { readOnly: true, files: "read", scope: "all" } });
    await expect(
      mutateChanges(target(fake.client), "unstage", new AbortController().signal, vi.fn()),
    ).rejects.toThrow("not allowed");
    expect(fake.sent).toEqual([]);
  });

  it("allows unstaging without changing unsaved worktree draft", async () => {
    const fake = connection();
    unsaved("/repo/src/a.ts");
    const chosen = target(fake.client);
    chosen.scope = "staged";
    chosen.entries = chosen.entries.slice(0, 1);
    const promise = mutateChanges(chosen, "unstage", new AbortController().signal, vi.fn());
    fake.reply();
    await promise;
    expect(useFileDrafts.getState().drafts[draftKey("alpha", "/repo/src/a.ts")]?.content).toBe(
      "unsaved",
    );
  });
});
