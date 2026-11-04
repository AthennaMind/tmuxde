import type { ClientMessage } from "@/protocol";
import type { RepositoryClient } from "@/features/repository/repository-request";

/** Match replies on this machine. Never retry a mutation after connection loss. */
export function fileOperation(
  client: RepositoryClient,
  request: Extract<
    ClientMessage,
    { type: "file:create" | "file:mkdir" | "file:rename" | "file:delete" }
  >,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return Promise.reject(new DOMException("Request cancelled", "AbortError"));
  if (client.status !== "connected") return Promise.reject(new Error("Connect to change files."));
  return new Promise((resolve, reject) => {
    const op =
      request.type === "file:create"
        ? "create"
        : request.type === "file:mkdir"
          ? "mkdir"
          : request.type === "file:delete"
            ? "delete"
            : "rename";
    const path = request.type === "file:rename" ? request.newPath : request.path;
    let offMessage = () => {};
    let offStatus = () => {};
    const cleanup = () => {
      clearTimeout(timer);
      offMessage();
      offStatus();
      signal.removeEventListener("abort", abort);
    };
    const fail = (error: Error) => {
      cleanup();
      reject(error);
    };
    const abort = () => fail(new DOMException("Request cancelled", "AbortError"));
    const timer = setTimeout(
      () => fail(new Error("Operation was not confirmed. Refresh folder before trying again.")),
      15_000,
    );
    offMessage = client.onMessage((message) => {
      if (message.type !== "file:op:result" || message.op !== op || message.path !== path) return;
      cleanup();
      if (message.success) resolve();
      else reject(new Error(message.error ?? `Could not ${op}.`));
    });
    offStatus = client.onStatusChange((status) => {
      if (status !== "connected") {
        fail(new Error("Connection lost. Refresh folder after reconnecting before trying again."));
      }
    });
    signal.addEventListener("abort", abort, { once: true });
    try {
      client.send(request);
    } catch {
      fail(new Error("Could not send request. Refresh folder before trying again."));
    }
  });
}
