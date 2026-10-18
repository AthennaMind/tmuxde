import { describe, expect, it, vi } from "vitest";
import type { ClientMessage, ServerMessage, FileUploadMessage } from "@/protocol";
import {
  uploadFileChunks,
  uploadPath,
  UPLOAD_CHUNK_SIZE,
  MAX_UPLOAD_SIZE,
  uploadLimit,
} from "./file-upload";

function client() {
  const handlers = new Set<(message: ServerMessage) => void>();
  const statuses = new Set<(status: "connected" | "disconnected") => void>();
  const sent: FileUploadMessage[] = [];
  return {
    status: "connected" as const,
    sent,
    send(message: ClientMessage) {
      if (message.type === "file:upload") sent.push(message);
    },
    onMessage(handler: (message: ServerMessage) => void) {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },
    onStatusChange(handler: (status: "connected" | "disconnected") => void) {
      statuses.add(handler);
      return () => {
        statuses.delete(handler);
      };
    },
    emit(message: ServerMessage) {
      handlers.forEach((handler) => handler(message));
    },
    ack() {
      const last = sent.at(-1)!;
      this.emit({
        type: "file:op:result",
        op: "upload",
        path: last.path,
        final: last.final,
        success: true,
      });
    },
    disconnect() {
      statuses.forEach((handler) => handler("disconnected"));
    },
    listeners() {
      return handlers.size + statuses.size;
    },
  };
}

describe("file upload", () => {
  it("uses each machine's advertised upload limit", () => {
    expect(uploadLimit([])).toBe(10 * 1024 * 1024);
    expect(uploadLimit(["file:upload:ack"])).toBe(10 * 1024 * 1024);
    expect(uploadLimit(["file:upload:ack", "file:upload:1gib"])).toBe(MAX_UPLOAD_SIZE);
  });

  it("waits for matching acknowledgements and preserves binary bytes", async () => {
    const connection = client();
    const data = new Uint8Array(UPLOAD_CHUNK_SIZE + 7).map((_, i) => i % 256);
    const progress = vi.fn();
    const task = uploadFileChunks(
      connection,
      new Blob([data]),
      "/folder/data.bin",
      new AbortController().signal,
      progress,
    );
    await vi.waitFor(() => expect(connection.sent).toHaveLength(1));
    connection.emit({
      type: "file:op:result",
      op: "upload",
      path: "/elsewhere",
      success: true,
      final: false,
    });
    expect(connection.sent).toHaveLength(1);
    expect(progress).not.toHaveBeenCalled();
    connection.ack();
    await vi.waitFor(() => expect(connection.sent).toHaveLength(2));
    expect(connection.sent[1]!.final).toBe(true);
    connection.ack();
    await task;
    expect(Buffer.concat(connection.sent.map((msg) => Buffer.from(msg.content, "base64")))).toEqual(
      Buffer.from(data),
    );
    expect(progress).toHaveBeenLastCalledWith(data.length);
    expect(connection.listeners()).toBe(0);
  });

  it("creates empty files with one final chunk", async () => {
    const connection = client();
    const task = uploadFileChunks(
      connection,
      new Blob(),
      "/empty",
      new AbortController().signal,
      () => {},
    );
    await vi.waitFor(() => expect(connection.sent).toHaveLength(1));
    expect(connection.sent[0]).toMatchObject({ content: "", final: true, ack: true });
    connection.ack();
    await task;
  });

  it.each(["cancel", "disconnect", "denied", "disk full"])(
    "stops remaining chunks after %s",
    async (reason) => {
      const connection = client();
      const controller = new AbortController();
      const task = uploadFileChunks(
        connection,
        new Blob([new Uint8Array(UPLOAD_CHUNK_SIZE * 2)]),
        "/target",
        controller.signal,
        () => {},
      );
      const rejected = expect(task).rejects.toThrow();
      await vi.waitFor(() => expect(connection.sent).toHaveLength(1));
      if (reason === "cancel") controller.abort();
      if (reason === "disconnect") connection.disconnect();
      if (reason === "denied")
        connection.emit({ type: "error", code: "ACCESS_DENIED", message: "Access denied" });
      if (reason === "disk full") {
        connection.emit({
          type: "file:op:result",
          op: "upload",
          path: "/target",
          success: false,
          error: "Disk full",
        });
      }
      await rejected;
      expect(connection.sent).toHaveLength(1);
      expect(connection.listeners()).toBe(0);
    },
  );

  it("rejects oversized files before reading any slice", async () => {
    const connection = client();
    const file = new Blob();
    Object.defineProperty(file, "size", { value: MAX_UPLOAD_SIZE + 1 });
    const slice = vi.spyOn(file, "slice");
    await expect(
      uploadFileChunks(connection, file, "/large", new AbortController().signal, () => {}),
    ).rejects.toThrow("1 GiB");
    expect(slice).not.toHaveBeenCalled();
    expect(connection.sent).toEqual([]);
  });

  it("does not send an already cancelled upload", async () => {
    const connection = client();
    const signal = AbortSignal.abort();
    await expect(
      uploadFileChunks(connection, new Blob(["x"]), "/x", signal, () => {}),
    ).rejects.toThrow();
    expect(connection.sent).toEqual([]);
  });

  it("joins root paths and rejects browser filenames containing path segments", () => {
    expect(uploadPath("/", "hello.txt")).toBe("/hello.txt");
    expect(uploadPath("/tmp/", "你好.txt")).toBe("/tmp/你好.txt");
    for (const name of ["..", "a/b", "a\\b", "", "a\0b"])
      expect(() => uploadPath("/tmp", name)).toThrow();
  });
});
