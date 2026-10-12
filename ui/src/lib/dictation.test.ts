import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientMessage } from "@repo/protocol";
import type { CaptureHandlers } from "./dictation-audio";

type StatusHandler = (status: string) => void;

const sent: ClientMessage[] = [];
const statusHandlers = new Set<StatusHandler>();
const client = {
  status: "connected",
  send: (msg: ClientMessage) => sent.push(msg),
  onStatusChange: (handler: StatusHandler) => {
    statusHandlers.add(handler);
    return () => statusHandlers.delete(handler);
  },
};
const terminal = { paste: vi.fn<(text: string) => void>() };

let handlers: CaptureHandlers | null = null;
const capture = { stop: vi.fn(async () => {}), abort: vi.fn() };
let openMicrophone: () => Promise<typeof capture> = async () => capture;

vi.mock("@/hooks/use-websocket", () => ({ getRelayClient: () => client }));
vi.mock("@/components/terminal/terminal-handle", () => ({
  getTerminalHandle: () => terminal,
}));
vi.mock("@/lib/dictation-audio", () => ({
  MicrophoneError: class MicrophoneError extends Error {},
  pcmToBase64: (pcm: Int16Array) => `pcm${pcm[0]}`,
  startCapture: (h: CaptureHandlers) => {
    handlers = h;
    return openMicrophone();
  },
}));

const dictation = await import("./dictation");
const { useConnectionStore } = await import("@/stores/connection-store");
const { useSessionStore } = await import("@/stores/session-store");
const { usePaneStore } = await import("@/stores/pane-store");
const { useDictationStore } = await import("@/stores/dictation-store");
const { useAlertStore } = await import("@/stores/alert-store");
const { useUiStore } = await import("@/stores/ui-store");
const { noteEnteredCopyMode, resetCopyModeBeliefForTests } = await import(
  "./copy-mode-belief"
);

const status = () => useDictationStore.getState().status;
const alerts = () => useAlertStore.getState().alerts.map((a) => a.message);
const types = () => sent.map((m) => m.type);
const idOf = () => (sent.find((m) => m.type === "dictation:start") as { id: string }).id;
const reply = (msg: Record<string, unknown>) =>
  dictation.handleDictationMessage({ id: idOf(), ...msg } as never);
const frame = (first: number) => handlers!.onFrame(new Int16Array([first]));

beforeEach(() => {
  sent.length = 0;
  statusHandlers.clear();
  handlers = null;
  openMicrophone = async () => capture;
  terminal.paste.mockReset();
  capture.stop.mockClear();
  capture.abort.mockClear();
  client.status = "connected";
  vi.stubGlobal("document", {
    activeElement: null,
    visibilityState: "visible",
    addEventListener: () => {},
    removeEventListener: () => {},
  });
  useConnectionStore.setState({
    status: "connected",
    features: new Set(["dictation"]),
    capabilities: null,
  });
  useSessionStore.setState({ activeSessionId: "work" });
  usePaneStore.setState({ activePaneId: "%1" });
  useAlertStore.setState({ alerts: [] });
  useUiStore.setState({ composerDraft: null });
  resetCopyModeBeliefForTests();
});

afterEach(() => {
  dictation.resetDictationForTests();
  vi.unstubAllGlobals();
});

describe("dictation", () => {
  it("asks the service first, then records", async () => {
    await dictation.startDictation();
    expect(types()).toEqual(["dictation:start"]);
    expect(status()).toBe("listening");
  });

  it("holds audio until the service is ready, then sends it in order", async () => {
    await dictation.startDictation();
    frame(1);
    frame(2);
    expect(types()).toEqual(["dictation:start"]);
    reply({ type: "dictation:ready" });
    frame(3);
    expect(sent.slice(1)).toEqual([
      { type: "dictation:audio", id: idOf(), pcm: "pcm1" },
      { type: "dictation:audio", id: idOf(), pcm: "pcm2" },
      { type: "dictation:audio", id: idOf(), pcm: "pcm3" },
    ]);
  });

  it("pastes each piece into the pane with a space between", async () => {
    await dictation.startDictation();
    reply({ type: "dictation:ready" });
    reply({ type: "dictation:text", text: "fix the bug" });
    reply({ type: "dictation:text", text: "в relay-а" });
    expect(terminal.paste.mock.calls).toEqual([["fix the bug"], [" в relay-а"]]);
  });

  it("stops: flushes the microphone, asks for the rest, ends on done", async () => {
    await dictation.startDictation();
    reply({ type: "dictation:ready" });
    reply({ type: "dictation:text", text: "hello" });
    await dictation.stopDictation();
    expect(capture.stop).toHaveBeenCalled();
    expect(types().at(-1)).toBe("dictation:stop");
    expect(status()).toBe("stopping");
    reply({ type: "dictation:done" });
    expect(status()).toBe("idle");
    expect(alerts()).toEqual([]);
  });

  it("sends stop only after the early audio when stopped before ready", async () => {
    await dictation.startDictation();
    frame(7);
    await dictation.stopDictation();
    expect(types()).toEqual(["dictation:start"]);
    reply({ type: "dictation:ready" });
    expect(types()).toEqual(["dictation:start", "dictation:audio", "dictation:stop"]);
  });

  it("says so when nothing was heard", async () => {
    await dictation.startDictation();
    reply({ type: "dictation:ready" });
    await dictation.stopDictation();
    reply({ type: "dictation:done" });
    expect(alerts()).toEqual(["No speech detected"]);
  });

  it("shows the service's error and ends", async () => {
    await dictation.startDictation();
    reply({ type: "dictation:error", code: "BUSY", message: "Speech service is busy" });
    expect(status()).toBe("idle");
    expect(capture.abort).toHaveBeenCalled();
    expect(alerts()).toEqual(["Speech service is busy"]);
  });

  it("sends the rest to Draft when the pane changes", async () => {
    await dictation.startDictation();
    reply({ type: "dictation:ready" });
    reply({ type: "dictation:text", text: "first" });
    usePaneStore.setState({ activePaneId: "%2" });
    reply({ type: "dictation:text", text: "second" });
    reply({ type: "dictation:text", text: "third" });
    expect(terminal.paste.mock.calls).toEqual([["first"]]);
    expect(useUiStore.getState().composerDraft).toBe("second third");
  });

  it("never pastes into a pane in copy mode", async () => {
    await dictation.startDictation();
    reply({ type: "dictation:ready" });
    noteEnteredCopyMode("work");
    reply({ type: "dictation:text", text: "words" });
    expect(terminal.paste).not.toHaveBeenCalled();
    expect(useUiStore.getState().composerDraft).toBe("words");
  });

  it("types into the focused field instead of the pane", async () => {
    const field = {
      tagName: "TEXTAREA",
      type: "textarea",
      readOnly: false,
      disabled: false,
      isConnected: true,
      value: "git commit -m",
      selectionStart: 13,
      selectionEnd: 13,
      classList: { contains: () => false },
      setRangeText(text: string, start: number, end: number) {
        this.value = this.value.slice(0, start) + text + this.value.slice(end);
        this.selectionStart = this.selectionEnd = start + text.length;
      },
      dispatchEvent: () => true,
    };
    vi.stubGlobal("document", {
      activeElement: field,
      visibilityState: "visible",
      addEventListener: () => {},
      removeEventListener: () => {},
    });
    await dictation.startDictation();
    reply({ type: "dictation:ready" });
    reply({ type: "dictation:text", text: "fix login" });
    expect(field.value).toBe("git commit -m fix login");
    expect(terminal.paste).not.toHaveBeenCalled();
  });

  it("ends quietly when the connection drops", async () => {
    await dictation.startDictation();
    client.status = "reconnecting";
    for (const handler of statusHandlers) handler("reconnecting");
    expect(status()).toBe("idle");
    expect(capture.abort).toHaveBeenCalled();
    expect(types()).toEqual(["dictation:start"]);
  });

  it("drops replies for a dictation that already ended", async () => {
    await dictation.startDictation();
    const old = idOf();
    dictation.cancelDictation();
    expect(types().at(-1)).toBe("dictation:cancel");
    dictation.handleDictationMessage({ type: "dictation:text", id: old, text: "late" });
    expect(terminal.paste).not.toHaveBeenCalled();
  });

  it("cancels the session when the microphone is refused", async () => {
    const { MicrophoneError } = await import("./dictation-audio");
    openMicrophone = async () => {
      throw new MicrophoneError("Microphone blocked");
    };
    await dictation.startDictation();
    expect(types()).toEqual(["dictation:start", "dictation:cancel"]);
    expect(status()).toBe("idle");
    expect(alerts()).toEqual(["Microphone blocked"]);
  });

  it("refuses to start in copy mode or without the feature", async () => {
    noteEnteredCopyMode("work");
    await dictation.startDictation();
    useConnectionStore.setState({ features: new Set() });
    resetCopyModeBeliefForTests();
    await dictation.startDictation();
    expect(sent).toEqual([]);
    expect(alerts()).toEqual([
      "Leave copy mode to dictate",
      "Dictation is not enabled on this machine",
    ]);
  });
});
