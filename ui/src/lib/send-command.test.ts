import { describe, it, expect, beforeEach, vi } from "vitest";

const sent: unknown[] = [];
let status = "connected";

vi.mock("@/hooks/use-websocket", () => ({
  getRelayClient: () => ({
    get status() {
      return status;
    },
    send: (message: unknown) => sent.push(message),
  }),
}));

import { sendCommand } from "./send-command";
import { useCommandStore } from "@/stores/command-store";
import { usePaneStore } from "@/stores/pane-store";

const pane = (command: string) =>
  ({ id: "%1", active: true, command }) as never;

beforeEach(() => {
  sent.length = 0;
  status = "connected";
  useCommandStore.setState({ history: [] });
  usePaneStore.setState({ panes: [pane("bash")], activePaneId: "%1" });
});

describe("sendCommand", () => {
  it("sends command:send, not terminal:input", () => {
    // `terminal:input` is dropped on the floor by the relay when nothing is
    // attached; `command:send` replies NOT_ATTACHED. A send that cannot land
    // should say so rather than vanish.
    expect(sendCommand("ls")).toBe(true);
    expect(sent).toEqual([{ type: "command:send", command: "ls" }]);
  });

  it("records history by default", () => {
    // The mobile bar never did, so nothing typed on a phone was ever
    // remembered — the palette's history was desktop-only by accident.
    sendCommand("ls -la");
    expect(useCommandStore.getState().history).toContain("ls -la");
  });

  it("skips history for generated commands", () => {
    // A `cd` from the file tree is navigation, not something the user typed.
    sendCommand("cd /tmp", { record: false });
    expect(useCommandStore.getState().history).toEqual([]);
    expect(sent).toHaveLength(1);
  });

  it("refuses empty and whitespace-only input", () => {
    expect(sendCommand("")).toBe(false);
    expect(sendCommand("   \n  ")).toBe(false);
    expect(sent).toEqual([]);
  });

  it("refuses to send while disconnected", () => {
    status = "connecting";
    expect(sendCommand("ls")).toBe(false);
    expect(sent).toEqual([]);
    // And nothing is recorded for a command that never left.
    expect(useCommandStore.getState().history).toEqual([]);
  });

  it("trims before sending", () => {
    sendCommand("  ls  ");
    expect(sent).toEqual([{ type: "command:send", command: "ls" }]);
  });
});

describe("multi-line sends", () => {
  const block = "echo one\necho two\necho three";

  it("wraps a block in bracketed paste when a shell is in front", () => {
    // Without it readline executes at the first newline, so lines two and
    // three run against whatever line one started.
    sendCommand(block);
    expect(sent).toEqual([
      {
        type: "command:send",
        command: `\x1b[200~${block}\x1b[201~\r`,
      },
    ]);
  });

  it("sends a block raw when the foreground is not a shell", () => {
    // vim has no idea what \x1b[200~ is and will type it into the document.
    usePaneStore.setState({ panes: [pane("vim")], activePaneId: "%1" });
    sendCommand(block);
    expect(sent).toEqual([{ type: "command:send", command: block }]);
  });

  it("treats an unknown foreground as not-a-shell", () => {
    // Fail towards the behaviour a paste has always had, rather than towards
    // a literal escape sequence on someone's screen.
    usePaneStore.setState({ panes: [], activePaneId: null });
    sendCommand(block);
    expect(sent).toEqual([{ type: "command:send", command: block }]);
  });

  it("leaves a single line alone", () => {
    sendCommand("ls");
    expect(sent).toEqual([{ type: "command:send", command: "ls" }]);
  });

  it("records what the user wrote, not what went on the wire", () => {
    sendCommand(block);
    expect(useCommandStore.getState().history[0]).toBe(block);
  });
});
