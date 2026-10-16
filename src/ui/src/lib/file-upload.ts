import type { ClientMessage, ServerMessage } from "@/protocol";
import type { RelayClient } from "./ws-client";

export const MAX_UPLOAD_SIZE = 1024 * 1024 * 1024;
export const LEGACY_UPLOAD_SIZE = 10 * 1024 * 1024;

export function uploadLimit(features: Iterable<string>): number {
  return new Set(features).has("file:upload:1gib") ? MAX_UPLOAD_SIZE : LEGACY_UPLOAD_SIZE;
}

export const UPLOAD_CHUNK_SIZE = 128 * 1024;
type UploadClient = Pick<RelayClient, "send" | "onMessage" | "onStatusChange" | "status">;

export function uploadPath(directory: string, name: string): string {
  if (!directory.startsWith("/") || !name || /[/\\\0]/.test(name) || name === "." || name === "..") {
    throw new Error("Invalid upload destination");
  }
  return `${directory.replace(/\/$/, "")}/${name}`;
}

/** One request at a time on a socket owned by this transfer. */
export function uploadReply(
  client: UploadClient,
  accepts: (message: ServerMessage) => boolean,
  signal: AbortSignal,
  send: () => void,
): Promise<ServerMessage> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    let offMessage = () => {};
    let offStatus = () => {};
    const clean = () => {
      clearTimeout(timer);
      offMessage();
      offStatus();
      signal.removeEventListener("abort", abort);
    };
    const fail = (error: unknown) => { clean(); reject(error); };
    const abort = () => fail(signal.reason);
    const timer = setTimeout(() => fail(new Error("Transfer timed out. Check destination before retrying.")), 30_000);
    signal.addEventListener("abort", abort, { once: true });
    offStatus = client.onStatusChange((status) => {
      if (status === "disconnected" || status === "reconnecting") {
        fail(new Error("Connection lost. Check destination before retrying."));
      }
    });
    offMessage = client.onMessage((message) => {
      if (message.type === "error" || message.type === "auth:failure") {
        fail(new Error(message.type === "error" ? message.message : message.reason));
      } else if (accepts(message)) {
        clean();
        resolve(message);
      }
    });
    try { send(); } catch (error) { fail(error); }
  });
}

/** Read bounded slices and wait until each chunk reaches disk. */
export async function uploadFileChunks(
  client: UploadClient,
  file: Blob,
  path: string,
  signal: AbortSignal,
  progress: (bytes: number) => void,
): Promise<void> {
  if (file.size > MAX_UPLOAD_SIZE) throw new Error("Upload limit is 1 GiB per file");
  let offset = 0;
  do {
    // Stay below hub rate limit even with near-zero round-trip latency.
    if (offset) await new Promise<void>((resolve, reject) => {
      const abort = () => { clearTimeout(timer); reject(signal.reason); };
      const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, 20);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
    signal.throwIfAborted();
    const bytes = new Uint8Array(await file.slice(offset, offset + UPLOAD_CHUNK_SIZE).arrayBuffer());
    signal.throwIfAborted();
    if (client.status !== "connected") throw new Error("Upload connection lost");
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    const end = offset + bytes.length;
    const final = end === file.size;
    const message: ClientMessage = { type: "file:upload", path, content: btoa(binary), final, ack: true };
    const reply = await uploadReply(
      client,
      (msg) => msg.type === "file:op:result" && msg.op === "upload" && msg.path === path,
      signal,
      () => client.send(message),
    );
    if (reply.type !== "file:op:result" || !reply.success) {
      throw new Error(reply.type === "file:op:result" ? reply.error ?? "Upload failed" : "Unexpected upload response");
    }
    if (reply.final !== final) throw new Error("Unexpected upload acknowledgement");
    offset = end;
    progress(offset);
  } while (offset < file.size);
}
