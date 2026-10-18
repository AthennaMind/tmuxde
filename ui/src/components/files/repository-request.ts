import type { ClientMessage, RepoResult } from "@/protocol";
import type { RelayClient } from "@/lib/ws-client";
import { usePaneStore } from "@/stores/pane-store";

export type RepositoryClient = Pick<
  RelayClient,
  "status" | "send" | "onMessage" | "onStatusChange"
>;
export type RepositoryQuery = Omit<
  Extract<ClientMessage, { type: "repo:request" }>,
  "type" | "requestId"
>;

let nextRequestId = 0;

/**
 * Whether the answer is the same through any pane. An absolute path names
 * its folder by itself. `context` and a relative path read the pane's folder.
 */
export function isPaneFree(query: RepositoryQuery): boolean {
  return query.action !== "context" && !!query.path?.startsWith("/");
}

/**
 * The pane to carry a request. The relay accepts any pane of the attached
 * session. The active pane is sure to be one. A pane saved with a tab, or
 * left over from before a switch, may be gone.
 */
function carrier(query: RepositoryQuery): string {
  return isPaneFree(query) ? (usePaneStore.getState().activePaneId ?? query.id) : query.id;
}

export function repositoryRequest(
  client: RepositoryClient,
  query: RepositoryQuery,
  signal?: AbortSignal,
): Promise<Exclude<RepoResult, { kind: "error" }>> {
  if (signal?.aborted) return Promise.reject(new DOMException("Request cancelled", "AbortError"));
  if (client.status !== "connected") return Promise.reject(new Error("Connect to browse files."));
  return new Promise((resolve, reject) => {
    const requestId = `repo-${Date.now().toString(36)}-${++nextRequestId}`;
    let unsubscribeMessage = () => {};
    let unsubscribeStatus = () => {};
    const cleanup = () => {
      clearTimeout(timeout);
      unsubscribeMessage();
      unsubscribeStatus();
      signal?.removeEventListener("abort", abort);
    };
    const fail = (error: Error) => {
      cleanup();
      reject(error);
    };
    const abort = () => fail(new DOMException("Request cancelled", "AbortError"));
    const timeout = setTimeout(
      () => fail(new Error("Request timed out. Refresh to try again.")),
      20_000,
    );
    unsubscribeMessage = client.onMessage((message) => {
      if (message.type !== "repo:result" || message.requestId !== requestId) return;
      cleanup();
      if (message.result.kind === "error") reject(new Error(message.result.message));
      else resolve(message.result);
    });
    unsubscribeStatus = client.onStatusChange((status) => {
      if (status !== "connected") fail(new Error("Connection lost. Reconnect to browse files."));
    });
    signal?.addEventListener("abort", abort, { once: true });
    try {
      client.send({
        type: "repo:request",
        requestId,
        ...query,
        id: carrier(query),
      });
    } catch (error) {
      fail(error instanceof Error ? error : new Error("Could not send request."));
    }
  });
}
