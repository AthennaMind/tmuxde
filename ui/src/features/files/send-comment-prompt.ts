import type { RelayClient } from "@/features/connection/ws-client";

export function sendCommentPrompt(
  client: Pick<RelayClient, "send" | "onMessage" | "onStatusChange">,
  id: string,
  command: string,
  text: string,
  submit: boolean,
) {
  const requestId = crypto.randomUUID();
  return new Promise<void>((resolve, reject) => {
    const unknown = "Delivery unconfirmed. Check the destination pane before sending again.";
    let connected = true;
    function checkReceipt() {
      if (connected) {
        try {
          client.send({ type: "pane:paste:status", requestId });
        } catch {
          // Retry the lookup on the next tick.
        }
      }
    }
    const poll = setInterval(checkReceipt, 4000);
    const timer = setTimeout(() => finish(unknown), 30000);
    const offMessage = client.onMessage((msg) => {
      if (msg.type === "pane:paste:result" && msg.requestId === requestId)
        finish(msg.success ? undefined : msg.error || "Pane rejected the paste.");
    });
    const offStatus = client.onStatusChange((status) => {
      connected = status === "connected";
      if (connected) checkReceipt();
    });
    function finish(error?: string) {
      clearTimeout(timer);
      clearInterval(poll);
      offMessage();
      offStatus();
      if (error) reject(new Error(error));
      else resolve();
    }
    try {
      client.send({ type: "pane:paste", id, command, text, submit, requestId });
    } catch {
      finish(unknown);
    }
  });
}
