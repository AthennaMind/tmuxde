import { describe, expect, it, vi } from "vitest";
import type { ClientMessage, ServerMessage, FileUploadMessage } from "@/protocol";
type Status = "connecting" | "connected" | "reconnecting" | "disconnected";
import { uploadPhoto, photoPathText, clipboardImage } from "./photo-upload-client";

function client() {
  const handlers = new Set<(msg: ServerMessage) => void>();
  const statuses = new Set<(status: Status) => void>();
  const sent: FileUploadMessage[] = [];
  return {
    status: "connected" as const,
    sent,
    onMessage(fn: (msg: ServerMessage) => void) {
      handlers.add(fn);
      return () => handlers.delete(fn);
    },
    onStatusChange(fn: (status: Status) => void) {
      statuses.add(fn);
      return () => statuses.delete(fn);
    },
    send: vi.fn((msg: ClientMessage) => {
      if (msg.type !== "file:upload") throw new Error("Unexpected message");
      sent.push(msg);
    }),
    emit(msg: ServerMessage) {
      handlers.forEach((fn) => fn(msg));
    },
    disconnect() {
      statuses.forEach((fn) => fn("disconnected"));
    },
    get listeners() {
      return handlers.size + statuses.size;
    },
  };
}
const photo = (size = 1) => new File([new Uint8Array(size)], "photo.png", { type: "image/png" });

describe("photo upload", () => {
  it("waits for each matching acknowledgement before next chunk and completion", async () => {
    const relay = client();
    const pending = uploadPhoto(relay, photo(200000), "/uploads");
    await vi.waitFor(() => expect(relay.sent).toHaveLength(1));
    const first = relay.sent[0]!;
    expect(first).toMatchObject({
      type: "file:upload",
      ack: true,
      final: false,
    });
    expect(first.path).toMatch(/^\/uploads\/photo-[a-f0-9-]+\.png$/);
    relay.emit({
      type: "file:op:result",
      op: "upload",
      path: "/unrelated",
      success: true,
      final: false,
    });
    expect(relay.sent).toHaveLength(1);
    relay.emit({
      type: "file:op:result",
      op: "upload",
      path: first.path,
      success: true,
      final: false,
    });
    await vi.waitFor(() => expect(relay.sent).toHaveLength(2));
    expect(relay.sent[1]!.final).toBe(true);
    relay.emit({
      type: "file:op:result",
      op: "upload",
      path: first.path,
      success: true,
      final: true,
    });
    expect(await pending).toBe(first.path);
    expect(relay.listeners).toBe(0);
    const bytes = Buffer.concat(relay.sent.map((msg) => Buffer.from(msg.content, "base64")));
    expect(bytes.length).toBe(200000);
  });
  it("rejects failed uploads and stops sending chunks", async () => {
    const relay = client();
    const pending = uploadPhoto(relay, photo(200000), "/uploads");
    const check = expect(pending).rejects.toThrow("Disk full");
    await vi.waitFor(() => expect(relay.sent).toHaveLength(1));
    relay.emit({
      type: "file:op:result",
      op: "upload",
      path: relay.sent[0]!.path,
      success: false,
      error: "Disk full",
    });
    await check;
    expect(relay.sent).toHaveLength(1);
    expect(relay.listeners).toBe(0);
  });
  it("rejects disconnects without replaying upload", async () => {
    const relay = client();
    const pending = uploadPhoto(relay, photo(), "/uploads");
    const check = expect(pending).rejects.toThrow("Connection lost");
    await vi.waitFor(() => expect(relay.sent).toHaveLength(1));
    relay.disconnect();
    await check;
    expect(relay.listeners).toBe(0);
  });
  it("rejects oversized files before sending anything", async () => {
    const relay = client();
    await expect(uploadPhoto(relay, photo(10 * 1024 * 1024 + 1), "/uploads")).rejects.toThrow(
      "10 MB",
    );
    expect(relay.sent).toHaveLength(0);
  });
  it("quotes paths and never includes Return or terminal control bytes", () => {
    expect(photoPathText("/uploads/p.png")).toBe(" /uploads/p.png ");
    expect(photoPathText("/a b/p.png")).toBe(" '/a b/p.png' ");
    expect(() => photoPathText("/evil\nfile")).toThrow();
  });
});

describe("clipboardImage", () => {
  const png = () => new File([new Uint8Array([1])], "image.png", { type: "image/png" });

  function clipboard(text: string, files: File[], { listed = true }: { listed?: boolean } = {}) {
    return {
      getData: (type: string) => (type === "text/plain" ? text : ""),
      items: (listed
        ? files.map((file) => ({
            kind: "file",
            type: file.type,
            getAsFile: () => file,
          }))
        : []) as unknown as DataTransferItemList,
      files: files as unknown as FileList,
    };
  }

  it("takes a screenshot that carries no text", () => {
    const file = png();
    expect(clipboardImage(clipboard("", [file]))).toBe(file);
  });

  it("keeps text when a copy carries both, like a spreadsheet range", () => {
    expect(clipboardImage(clipboard("A1\tB1", [png()]))).toBeNull();
  });

  it("treats whitespace-only text as no text", () => {
    const file = png();
    expect(clipboardImage(clipboard(" \n", [file]))).toBe(file);
  });

  it("ignores files that are not images", () => {
    const pdf = new File([new Uint8Array([1])], "a.pdf", {
      type: "application/pdf",
    });
    expect(clipboardImage(clipboard("", [pdf]))).toBeNull();
  });

  it("falls back to the file list when items are empty", () => {
    const file = png();
    expect(clipboardImage(clipboard("", [file], { listed: false }))).toBe(file);
  });

  it("returns null without clipboard data", () => {
    expect(clipboardImage(null)).toBeNull();
  });
});
