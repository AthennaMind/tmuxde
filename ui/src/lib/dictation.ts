import type { ServerMessage } from "@/protocol";
import { getRelayClient } from "@/hooks/use-websocket";
import type { RelayClient } from "@/lib/ws-client";
import { useAlertStore } from "@/stores/alert-store";
import { isReadOnly, useConnectionStore } from "@/stores/connection-store";
import { useDictationStore } from "@/stores/dictation-store";
import { usePaneStore } from "@/stores/pane-store";
import { useSessionStore } from "@/stores/session-store";
import { useUiStore } from "@/stores/ui-store";
import { getTerminalHandle, type TerminalHandle } from "@/components/terminal/terminal-handle";
import { believedInCopyMode } from "@/lib/copy-mode-belief";
import { useTerminalInput } from "@/lib/terminal-input.js";
import { startCapture, pcmToBase64, MicrophoneError, type Capture } from "@/lib/dictation-audio";
import {
  insertIntoField,
  isTextField,
  joinSegment,
  sanitizeDictation,
  textBeforeCaret,
  type TextField,
} from "@/lib/dictation-text";

/**
 * Talk, and the words land where you were typing.
 *
 * Where is decided when dictation starts. A focused text field (the command
 * bar, the composer) gets the text at its caret. Otherwise the selected pane
 * gets it as a paste, which never presses Enter. If that pane stops being
 * the one on screen mid-dictation, the rest goes to the composer rather than
 * into a pane the user is no longer looking at.
 *
 * Audio streams to the relay as it is recorded, so most of a long dictation
 * is already text by the time the user stops.
 */

/** The speech service stops taking audio at ten minutes. Stop just before. */
const MAX_RECORDING_MS = 10 * 60_000 - 5000;
/** How long to wait for the speech service to answer `dictation:start`. */
const READY_TIMEOUT_MS = 10_000;
/** How long the last words may take after Stop. */
const DONE_TIMEOUT_MS = 60_000;
/** Audio kept on the device while the speech service connects: 30 s. */
const MAX_EARLY_FRAMES = 150;

type Target =
  | { kind: "field"; field: TextField }
  | {
      kind: "terminal";
      session: string;
      pane: string | null;
      terminal: TerminalHandle;
    }
  | { kind: "composer" };

type Run = {
  id: string;
  client: RelayClient;
  target: Target;
  /** Everything this dictation typed into the terminal, for spacing. */
  typed: string;
  inserted: boolean;
  capture: Capture | null;
  microphoneRequest: AbortController;
  ready: boolean;
  early: string[];
  stopping: boolean;
  /** Stop arrived before the service did. Sent right after the early audio. */
  stopWhenReady: boolean;
  timers: ReturnType<typeof setTimeout>[];
  cleanup: (() => void)[];
};

let run: Run | null = null;

function alert(type: "info" | "error", message: string) {
  useAlertStore.getState().push(type, message);
}

/** Why dictation cannot start right now, or null when it can. */
export function dictationBlocker(): string | null {
  const connection = useConnectionStore.getState();
  if (!connection.features.has("dictation")) {
    return "Dictation is not enabled on this machine";
  }
  if (isReadOnly(connection.capabilities)) return "This is a read-only session";
  if (connection.status !== "connected") return "Not connected";
  return null;
}

function captureTarget(): Target | null {
  const active = typeof document === "undefined" ? null : document.activeElement;
  if (isTextField(active)) return { kind: "field", field: active };
  const session = useSessionStore.getState().activeSessionId;
  const terminal = getTerminalHandle();
  if (!session || !terminal) return null;
  return {
    kind: "terminal",
    session,
    pane: usePaneStore.getState().activePaneId,
    terminal,
  };
}

function terminalStillThere(current: Run, target: Extract<Target, { kind: "terminal" }>): boolean {
  return (
    getRelayClient() === current.client &&
    current.client.status === "connected" &&
    useSessionStore.getState().activeSessionId === target.session &&
    usePaneStore.getState().activePaneId === target.pane &&
    getTerminalHandle() === target.terminal &&
    !believedInCopyMode(target.session)
  );
}

function insert(current: Run, text: string): void {
  const clean = sanitizeDictation(text);
  if (!clean) return;
  current.inserted = true;
  const { target } = current;

  if (target.kind === "field") {
    if (target.field.isConnected && !target.field.disabled) {
      insertIntoField(target.field, joinSegment(textBeforeCaret(target.field), clean));
      return;
    }
    current.target = { kind: "composer" };
  } else if (target.kind === "terminal") {
    if (terminalStillThere(current, target)) {
      const piece = joinSegment(current.typed, clean);
      useTerminalInput.getState().reset();
      target.terminal.paste(piece);
      current.typed += piece;
      return;
    }
    current.target = { kind: "composer" };
    alert("info", "Pane changed, so the rest of the dictation went to Draft");
  }

  const ui = useUiStore.getState();
  if (ui.composerDraft === null) ui.openComposer(clean);
  else ui.setComposerDraft(ui.composerDraft + joinSegment(ui.composerDraft, clean));
}

function setStatus(status: "starting" | "listening" | "stopping") {
  useDictationStore.setState((s) => ({
    status,
    startedAt: status === "listening" ? (s.startedAt ?? Date.now()) : s.startedAt,
  }));
}

/** Tear down everything local. Sends nothing. */
function finish(current: Run): void {
  if (run !== current) return;
  run = null;
  for (const timer of current.timers) clearTimeout(timer);
  for (const off of current.cleanup) off();
  current.microphoneRequest.abort();
  current.capture?.abort();
  current.early = [];
  useDictationStore.setState({ status: "idle", level: 0, startedAt: null });
}

function sendFrame(current: Run, pcm: Int16Array): void {
  if (run !== current) return;
  const encoded = pcmToBase64(pcm);
  if (current.ready) {
    current.client.send({ type: "dictation:audio", id: current.id, pcm: encoded });
    return;
  }
  current.early.push(encoded);
  if (current.early.length > MAX_EARLY_FRAMES) {
    abortDictation("Speech service did not answer");
  }
}

/** Start or stop, whichever applies. For the mic buttons and the hotkey. */
export function toggleDictation(): void {
  if (run) void stopDictation();
  else void startDictation();
}

/**
 * Start recording. Call from a user gesture: browsers only grant the
 * microphone and start audio inside one.
 */
export async function startDictation(): Promise<void> {
  if (run) return;
  const blocked = dictationBlocker();
  const client = getRelayClient();
  if (blocked || !client) {
    alert("error", blocked ?? "Not connected");
    return;
  }
  const target = captureTarget();
  if (!target) {
    alert("error", "Open a session first");
    return;
  }
  if (target.kind === "terminal" && believedInCopyMode(target.session)) {
    alert("error", "Leave copy mode to dictate");
    return;
  }

  const current: Run = {
    id: crypto.randomUUID(),
    client,
    target,
    typed: "",
    inserted: false,
    capture: null,
    microphoneRequest: new AbortController(),
    ready: false,
    early: [],
    stopping: false,
    stopWhenReady: false,
    timers: [],
    cleanup: [],
  };
  run = current;
  setStatus("starting");

  current.cleanup.push(
    client.onStatusChange((status) => {
      if (status !== "connected") abortDictation("Dictation stopped. Connection lost.", false);
    }),
  );
  // A phone that locks or switches app takes the microphone away anyway.
  // Finish what was said instead of losing it.
  const onHidden = () => {
    if (document.visibilityState === "hidden") void stopDictation();
  };
  document.addEventListener("visibilitychange", onHidden);
  current.cleanup.push(() => document.removeEventListener("visibilitychange", onHidden));
  current.timers.push(
    setTimeout(() => {
      if (run === current && !current.ready) abortDictation("Speech service did not answer");
    }, READY_TIMEOUT_MS),
  );

  // Ask the service first, so it connects while the user answers the
  // microphone prompt.
  client.send({ type: "dictation:start", id: current.id });

  let capture: Capture;
  try {
    capture = await startCapture(
      {
        onFrame: (pcm) => sendFrame(current, pcm),
        onLevel: (level) => {
          if (run === current) useDictationStore.setState({ level });
        },
        onEnded: () => {
          if (run !== current) return;
          alert("error", "Microphone disconnected");
          void stopDictation();
        },
      },
      current.microphoneRequest.signal,
    );
  } catch (error) {
    if (run === current) {
      abortDictation(
        error instanceof MicrophoneError ? error.message : "Could not open the microphone",
      );
    }
    return;
  }
  if (run !== current) {
    capture.abort();
    return;
  }
  current.capture = capture;
  setStatus("listening");
  current.timers.push(
    setTimeout(() => {
      if (run !== current || current.stopping) return;
      alert("info", "Dictation stops at ten minutes");
      void stopDictation();
    }, MAX_RECORDING_MS),
  );
}

/** Stop recording. What was said is still transcribed and inserted. */
export async function stopDictation(): Promise<void> {
  const current = run;
  if (!current || current.stopping) return;
  if (!current.capture) {
    // Still waiting on the microphone prompt. Nothing was recorded.
    cancelDictation();
    return;
  }
  current.stopping = true;
  setStatus("stopping");
  await current.capture.stop();
  if (run !== current) return;
  current.timers.push(
    setTimeout(() => {
      if (run === current) abortDictation("Transcription took too long");
    }, DONE_TIMEOUT_MS),
  );
  if (current.ready) current.client.send({ type: "dictation:stop", id: current.id });
  else current.stopWhenReady = true;
}

/** Stop and throw away anything not yet inserted. */
export function cancelDictation(): void {
  const current = run;
  if (!current) return;
  if (current.client.status === "connected") {
    current.client.send({ type: "dictation:cancel", id: current.id });
  }
  finish(current);
}

function abortDictation(message: string, tell = true): void {
  const current = run;
  if (!current) return;
  if (tell) cancelDictation();
  else finish(current);
  alert("error", message);
}

type DictationReply = Extract<
  ServerMessage,
  { type: "dictation:ready" | "dictation:text" | "dictation:done" | "dictation:error" }
>;

/** Replies from the relay. Anything for a dictation already gone is dropped. */
export function handleDictationMessage(msg: DictationReply): void {
  const current = run;
  if (!current || current.id !== msg.id) return;
  switch (msg.type) {
    case "dictation:ready":
      current.ready = true;
      for (const pcm of current.early) {
        current.client.send({ type: "dictation:audio", id: current.id, pcm });
      }
      current.early = [];
      if (current.stopWhenReady) {
        current.client.send({ type: "dictation:stop", id: current.id });
      }
      break;
    case "dictation:text":
      insert(current, msg.text);
      break;
    case "dictation:done":
      finish(current);
      if (!current.inserted) alert("info", "No speech detected");
      break;
    case "dictation:error":
      finish(current);
      alert("error", msg.message);
      break;
  }
}

/** Test seam: forget any dictation without touching the network. */
export function resetDictationForTests(): void {
  if (run) finish(run);
}
