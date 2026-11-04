import { afterEach, describe, expect, it, vi } from "vitest";
import type { ServerMessage } from "@/protocol";
import type { RepositoryClient } from "@/features/repository/repository-request";
import { createFileEntry, newEntryPath } from "./file-create-request";

function connection() {
  const messages = new Set<(message: ServerMessage) => void>();
  const statuses = new Set<Parameters<RepositoryClient["onStatusChange"]>[0]>();
  const send = vi.fn();
  const client: RepositoryClient = {
    status: "connected",
    send,
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
  const reply = (message: ServerMessage) => {
    for (const handler of messages) handler(message);
  };
  return { client, messages, statuses, send, reply };
}

afterEach(() => vi.useRealTimers());

describe("file creation", () => {
  it.each([
    "",
    " ",
    ".",
    "..",
    "../outside",
    "/absolute",
    "nested/file",
    "bad\u0000name",
    "line\nfeed",
  ])("rejects invalid child name %j", (name) => {
    expect(() => newEntryPath("/workspace", name)).toThrow();
  });

  it("keeps dotfiles, spaces and Unicode names in destination folder", () => {
    expect(newEntryPath("/workspace/", ".env")).toBe("/workspace/.env");
    expect(newEntryPath("/", "notes ü.txt")).toBe("/notes ü.txt");
  });

  it.each(["file", "folder"] as const)("matches %s result by path and operation", async (kind) => {
    const fake = connection();
    const controller = new AbortController();
    const op = kind === "file" ? "create" : "mkdir";
    const pending = createFileEntry(fake.client, "/workspace/new", kind, controller.signal);
    fake.reply({ type: "file:op:result", op, path: "/other/new", success: true });
    fake.reply({ type: "file:op:result", op: "delete", path: "/workspace/new", success: true });
    expect(fake.messages.size).toBe(1);
    fake.reply({ type: "file:op:result", op, path: "/workspace/new", success: true });
    await pending;
    expect(fake.send).toHaveBeenCalledExactlyOnceWith({
      type: kind === "file" ? "file:create" : "file:mkdir",
      path: "/workspace/new",
    });
    expect(fake.messages.size + fake.statuses.size).toBe(0);
  });

  it("surfaces server rejection without retrying or overwriting", async () => {
    const fake = connection();
    const pending = createFileEntry(fake.client, "/existing", "file", new AbortController().signal);
    fake.reply({
      type: "file:op:result",
      op: "create",
      path: "/existing",
      success: false,
      error: "File exists",
    });
    await expect(pending).rejects.toThrow("File exists");
    expect(fake.send).toHaveBeenCalledTimes(1);
    expect(fake.messages.size + fake.statuses.size).toBe(0);
  });

  it("does not replay creation after disconnect", async () => {
    const fake = connection();
    const pending = createFileEntry(fake.client, "/new", "folder", new AbortController().signal);
    for (const handler of fake.statuses) handler("reconnecting");
    await expect(pending).rejects.toThrow("Connection lost");
    for (const handler of fake.statuses) handler("connected");
    expect(fake.send).toHaveBeenCalledTimes(1);
    expect(fake.messages.size + fake.statuses.size).toBe(0);
  });

  it("releases subscriptions when dialog unmounts", async () => {
    const fake = connection();
    const controller = new AbortController();
    const pending = createFileEntry(fake.client, "/new", "file", controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(fake.messages.size + fake.statuses.size).toBe(0);
  });

  it("asks to check folder after timeout without retrying", async () => {
    vi.useFakeTimers();
    const fake = connection();
    const pending = createFileEntry(fake.client, "/new", "file", new AbortController().signal);
    const result = expect(pending).rejects.toThrow("Refresh folder");
    await vi.advanceTimersByTimeAsync(15_000);
    await result;
    expect(fake.send).toHaveBeenCalledTimes(1);
    expect(fake.messages.size + fake.statuses.size).toBe(0);
  });
});
