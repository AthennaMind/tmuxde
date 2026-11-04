import type { ClientMessage, ServerMessage } from "@/protocol";
import type { RepositoryClient } from "@/features/repository/repository-request";

type ReadRequest = Extract<ClientMessage, { type: "file:edit:read" }>;
type SaveRequest = Extract<ClientMessage, { type: "file:edit:save" }>;
type EditRequest = Omit<ReadRequest, "requestId"> | Omit<SaveRequest, "requestId">;
type EditResult = Extract<ServerMessage, { type: "file:edit:result" }>["result"];

let sequence = 0;

/** Each request belongs to this connection. Writes are never retried. */
export function fileEditRequest(
  client: RepositoryClient,
  request: EditRequest,
): Promise<EditResult> {
  if (client.status !== "connected") return Promise.reject(new Error("Connection lost."));
  return new Promise((resolve, reject) => {
    const requestId = `edit-${Date.now().toString(36)}-${++sequence}`;
    if (
      new TextEncoder().encode(JSON.stringify({ ...request, requestId })).byteLength > 1_048_576
    ) {
      reject(new Error("File exceeds connection message limit. Your edits are kept."));
      return;
    }
    let offMessage = () => {};
    let offStatus = () => {};
    const cleanup = () => {
      clearTimeout(timer);
      offMessage();
      offStatus();
    };
    const fail = (message: string) => {
      cleanup();
      reject(new Error(message));
    };
    const timer = setTimeout(() => fail("Request timed out. Recheck before saving."), 15_000);
    offMessage = client.onMessage((message) => {
      if (
        message.type !== "file:edit:result" ||
        message.requestId !== requestId ||
        message.path !== request.path
      )
        return;
      cleanup();
      resolve(message.result);
    });
    offStatus = client.onStatusChange((status) => {
      if (status !== "connected") fail("Connection lost. Draft kept in this browser tab.");
    });
    try {
      client.send({ ...request, requestId });
    } catch {
      fail("Could not send request. Recheck before saving.");
    }
  });
}
