import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientMessage, FileDocument, ServerMessage } from "@/protocol";
import type { RepositoryClient } from "@/features/repository/repository-request";
import { disconnectAll } from "@/features/connection/relay-registry";
import {
  acceptDiskVersion,
  checkDraft,
  closeDraft,
  draftKey,
  draftModified,
  editDraft,
  openDraft,
  saveDraft,
  setDraftOnline,
  useFileDrafts,
} from "./file-drafts";

function fakeClient() {
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
  function reply(
    document: FileDocument,
    status: "ok" | "conflict" = "ok",
    index = sent.length - 1,
  ) {
    const request = sent[index];
    if (request?.type !== "file:edit:read" && request?.type !== "file:edit:save")
      throw new Error("Missing edit request");
    for (const handler of messages)
      handler({
        type: "file:edit:result",
        requestId: request.requestId,
        path: request.path,
        result: { status, document },
      });
  }
  return { client, sent, messages, statuses, reply };
}

const doc = (content: string, revision = "a"): FileDocument => ({
  content,
  revision: revision.repeat(64),
  writable: true,
});
const key = draftKey("local", "/notes.txt");
const current = () => useFileDrafts.getState().drafts[key]!;

async function loaded(machine = "local") {
  const fake = fakeClient();
  const id = draftKey(machine, "/notes.txt");
  openDraft(machine, "/notes.txt");
  setDraftOnline(id, true);
  const loading = checkDraft(id, fake.client);
  fake.reply(doc("base"));
  await loading;
  return fake;
}

beforeEach(() => useFileDrafts.setState({ drafts: {} }));
afterEach(() => vi.useRealTimers());

describe("file drafts", () => {
  it("keeps oversized drafts without sending a frame or leaking listeners", async () => {
    const fake = await loaded();
    const content = "\t".repeat(600_000);
    editDraft(key, content);
    await saveDraft(key, fake.client);
    expect(fake.sent).toHaveLength(1);
    expect(current().content).toBe(content);
    expect(current().error).toContain("message limit");
    expect(fake.messages.size).toBe(0);
    expect(fake.statuses.size).toBe(0);
  });

  it("keeps typing that arrives while a save is in flight", async () => {
    const fake = await loaded();
    editDraft(key, "first edit");
    const saving = saveDraft(key, fake.client);
    editDraft(key, "newer edit");
    fake.reply(doc("first edit", "b"));
    await saving;
    expect(current().content).toBe("newer edit");
    expect(current().base?.content).toBe("first edit");
    expect(draftModified(current())).toBe(true);
    expect(fake.messages.size).toBe(0);
    expect(fake.statuses.size).toBe(0);
  });

  it("preserves dirty text on disk changes and guards explicit replacement", async () => {
    const fake = await loaded();
    editDraft(key, "mine");
    const checking = checkDraft(key, fake.client);
    fake.reply(doc("external", "b"));
    await checking;
    expect(current().content).toBe("mine");
    expect(current().conflict?.content).toBe("external");
    await saveDraft(key, fake.client);
    expect(fake.sent).toHaveLength(2);
    const saving = saveDraft(key, fake.client, true);
    expect(fake.sent.at(-1)).toMatchObject({
      type: "file:edit:save",
      revision: "b".repeat(64),
      content: "mine",
    });
    fake.reply(doc("changed again", "c"), "conflict");
    await saving;
    expect(current().conflict?.content).toBe("changed again");
    expect(current().content).toBe("mine");
    acceptDiskVersion(key);
    expect(current().content).toBe("changed again");
    expect(draftModified(current())).toBe(false);
  });

  it("reconciles an unacknowledged save without replaying it", async () => {
    const fake = await loaded();
    editDraft(key, "sent");
    const saving = saveDraft(key, fake.client);
    editDraft(key, "typed later");
    setDraftOnline(key, false);
    for (const handler of fake.statuses) handler("reconnecting");
    await saving;
    expect(current().pending).toBe("sent");
    expect(current().content).toBe("typed later");
    setDraftOnline(key, true);
    const checking = checkDraft(key, fake.client);
    fake.reply(doc("sent", "b"));
    await checking;
    expect(current().base?.content).toBe("sent");
    expect(current().content).toBe("typed later");
    expect(current().conflict).toBeNull();
    expect(current().paused).toBe(true);
    expect(fake.sent.filter((message) => message.type === "file:edit:save")).toHaveLength(1);
  });

  it("keeps same paths on different machines independent", async () => {
    const local = await loaded();
    const remote = await loaded("macbook");
    editDraft(key, "local edit");
    const remoteKey = draftKey("macbook", "/notes.txt");
    editDraft(remoteKey, "Mac edit");
    const saving = saveDraft(remoteKey, remote.client);
    remote.reply(doc("Mac edit", "b"));
    await saving;
    expect(current().content).toBe("local edit");
    expect(local.sent).toHaveLength(1);
    expect(useFileDrafts.getState().drafts[remoteKey]?.base?.content).toBe("Mac edit");
  });

  it("does not overwrite typing with a late refresh", async () => {
    const fake = await loaded();
    const checking = checkDraft(key, fake.client);
    editDraft(key, "typed during refresh");
    fake.reply(doc("external", "b"));
    await checking;
    expect(current().content).toBe("typed during refresh");
    expect(current().conflict?.content).toBe("external");
  });

  it("ignores replies for a closed and reopened draft", async () => {
    const fake = await loaded();
    const checking = checkDraft(key, fake.client);
    closeDraft(key);
    openDraft("local", "/notes.txt");
    fake.reply(doc("old reply", "b"));
    await checking;
    expect(current().base).toBeNull();
  });

  it("keeps timeout drafts and blocks saves until disk is rechecked", async () => {
    vi.useFakeTimers();
    const fake = await loaded();
    editDraft(key, "mine");
    const saving = saveDraft(key, fake.client);
    await vi.advanceTimersByTimeAsync(15_000);
    await saving;
    expect(current()).toMatchObject({
      content: "mine",
      pending: "mine",
      paused: true,
      needsCheck: true,
    });
    await saveDraft(key, fake.client);
    expect(fake.sent).toHaveLength(2);
    expect(fake.messages.size).toBe(0);
  });

  it("clears private draft contents when all connections lock or sign out", async () => {
    await loaded();
    editDraft(key, "private");
    disconnectAll();
    expect(useFileDrafts.getState().drafts).toEqual({});
  });
});
