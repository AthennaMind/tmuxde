import { describe, expect, it, vi } from "vitest";
import type { ClientMessage, ServerMessage } from "@/protocol";
import { sendCommentPrompt } from "./send-comment-prompt";

function connection() {
  const unlistenMessage = vi.fn(),
    unlistenStatus = vi.fn();
  let receive: (msg: ServerMessage) => void = () => {};
  let statusChange: (status: "connected" | "disconnected") => void = () => {};
  const sent = vi.fn<(msg: ClientMessage) => void>();
  const client = {
    send: sent,
    onMessage(handler: typeof receive) {
      receive = handler;
      return unlistenMessage;
    },
    onStatusChange(handler: typeof statusChange) {
      statusChange = handler;
      return unlistenStatus;
    },
  };
  const pending = sendCommentPrompt(client, "%1", "codex", "review", true);
  const message = sent.mock.calls[0]?.[0];
  if (message?.type !== "pane:paste" || !message.requestId)
    throw new Error("Expected correlated paste");
  return {
    pending,
    statusChange,
    unlistenMessage,
    unlistenStatus,
    sent,
    reply: (success: boolean, requestId = message.requestId!) =>
      receive({ type: "pane:paste:result", requestId, success }),
  };
}
describe("comment delivery", () => {
  it("waits for its own acknowledgement", async () => {
    const c = connection();
    c.reply(false, "different");
    expect(c.unlistenMessage).not.toHaveBeenCalled();
    c.reply(true);
    await c.pending;
    expect(c.unlistenMessage).toHaveBeenCalledOnce();
    expect(c.unlistenStatus).toHaveBeenCalledOnce();
  });
  it("reports rejection", async () => {
    const c = connection();
    c.reply(false);
    await expect(c.pending).rejects.toThrow("rejected");
  });
  it("does not resend after losing the socket", async () => {
    const c = connection();
    c.statusChange("disconnected");
    c.statusChange("connected");
    expect(c.sent.mock.calls.map(([m]) => m.type)).toEqual(["pane:paste", "pane:paste:status"]);
    c.reply(true);
    await c.pending;
  });
  it("preserves uncertainty after the recovery window", async () => {
    vi.useFakeTimers();
    const c = connection();
    c.statusChange("disconnected");
    vi.advanceTimersByTime(30000);
    vi.useRealTimers();
    await expect(c.pending).rejects.toThrow("unconfirmed");
    expect(c.sent).toHaveBeenCalledTimes(1);
  });
});
