import { WebSocket } from "ws";
import { z } from "zod";
import type { ServerMessage } from "@repo/protocol";
import { createLogger } from "@repo/logger";
import { config } from "./config.js";

const logger = createLogger("relay:dictation");

/**
 * What the speech service sends. Mirrors `apps/stt/src/session.ts`.
 *
 * Validated even though the service is ours: it is a separate process on a
 * separate container, and nothing it says reaches a browser unchecked.
 */
const SttMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ready") }),
  z.object({ type: z.literal("text"), text: z.string().max(20_000) }),
  z.object({ type: z.literal("done") }),
  z.object({ type: z.literal("error"), code: z.string(), message: z.string() }),
]);

/** Audio queued toward the service before it backs up. About 30 s of speech. */
const MAX_BUFFERED_BYTES = 1024 * 1024;
/** Backstop for a session nobody ends. The service stops audio at 10 minutes. */
const MAX_SESSION_MS = 15 * 60_000;
const CONNECT_TIMEOUT_MS = 5000;

export type DictationSession = {
  id: string;
  socket: WebSocket;
  /** Audio and stop that arrived while the socket was still connecting. */
  early: Buffer[];
  earlyBytes: number;
  stopRequested: boolean;
  opened: boolean;
  ended: boolean;
  timer: ReturnType<typeof setTimeout>;
};

/** The part of a connection this module owns. */
export type DictationHolder = { dictation: DictationSession | null };
type Send = (msg: ServerMessage) => void;
type Options = { url?: string; maxSessionMs?: number };

function streamUrl(base: string): string {
  return new URL("/v1/stream", base).toString();
}

function end(holder: DictationHolder, session: DictationSession): void {
  if (session.ended) return;
  session.ended = true;
  clearTimeout(session.timer);
  session.early = [];
  if (holder.dictation === session) holder.dictation = null;
  const { socket } = session;
  if (socket.readyState === WebSocket.OPEN) socket.close(1000);
  else if (socket.readyState === WebSocket.CONNECTING) socket.terminate();
}

function fail(
  holder: DictationHolder,
  session: DictationSession,
  send: Send,
  code: string,
  message: string,
): void {
  if (session.ended) return;
  end(holder, session);
  send({ type: "dictation:error", id: session.id, code, message });
}

/**
 * Open a session on the speech service for this connection.
 *
 * Tried even when the health probe last said no. The probe only decides
 * whether browsers are offered a mic, and a stale "down" should not refuse
 * someone the service could have answered.
 */
export function startDictation(
  holder: DictationHolder,
  id: string,
  send: Send,
  { url = config.sttUrl, maxSessionMs = MAX_SESSION_MS }: Options = {},
): void {
  if (holder.dictation) end(holder, holder.dictation);
  if (!url) {
    send({
      type: "dictation:error",
      id,
      code: "UNAVAILABLE",
      message: "Dictation is not enabled on this machine",
    });
    return;
  }

  const socket = new WebSocket(streamUrl(url), {
    handshakeTimeout: CONNECT_TIMEOUT_MS,
    maxPayload: 256 * 1024,
  });
  const session: DictationSession = {
    id,
    socket,
    early: [],
    earlyBytes: 0,
    stopRequested: false,
    opened: false,
    ended: false,
    timer: setTimeout(
      () => fail(holder, session, send, "FAILED", "Dictation ran too long"),
      maxSessionMs,
    ),
  };
  holder.dictation = session;

  socket.on("open", () => {
    session.opened = true;
    for (const frame of session.early) socket.send(frame);
    session.early = [];
    session.earlyBytes = 0;
    if (session.stopRequested) socket.send(JSON.stringify({ type: "stop" }));
  });

  socket.on("message", (data, isBinary) => {
    if (session.ended || isBinary) return;
    let parsed: z.infer<typeof SttMessage>;
    try {
      parsed = SttMessage.parse(JSON.parse(String(data)));
    } catch (err) {
      logger.warn({ err }, "Unexpected message from speech service");
      fail(holder, session, send, "FAILED", "Speech service sent nonsense");
      return;
    }
    switch (parsed.type) {
      case "ready":
        send({ type: "dictation:ready", id });
        break;
      case "text":
        send({ type: "dictation:text", id, text: parsed.text });
        break;
      case "done":
        end(holder, session);
        send({ type: "dictation:done", id });
        break;
      case "error":
        fail(holder, session, send, "FAILED", parsed.message);
        break;
    }
  });

  socket.on("close", (code) => {
    if (session.ended) return;
    if (code === 1013) {
      fail(holder, session, send, "BUSY", "Speech service is busy. Try again shortly.");
    } else {
      fail(holder, session, send, "FAILED", "Speech service closed the connection");
    }
  });

  socket.on("error", (err) => {
    // `close` follows, but its code cannot tell "never reached" from "dropped".
    if (session.ended) return;
    logger.warn({ err: err.message }, "Speech service connection failed");
    if (session.opened) {
      fail(holder, session, send, "FAILED", "Lost the speech service");
    } else {
      fail(holder, session, send, "UNAVAILABLE", "Speech service is not reachable");
    }
  });
}

function current(
  holder: DictationHolder,
  id: string,
  send: Send,
): DictationSession | null {
  const session = holder.dictation;
  if (session && session.id === id && !session.ended) return session;
  send({
    type: "dictation:error",
    id,
    code: "NOT_FOUND",
    message: "No dictation is running",
  });
  return null;
}

/** Forward one base64 PCM frame. */
export function feedDictation(
  holder: DictationHolder,
  id: string,
  pcm: string,
  send: Send,
): void {
  const session = current(holder, id, send);
  if (!session || session.stopRequested) return;
  const frame = Buffer.from(pcm, "base64");
  if (frame.length === 0) return;
  const { socket } = session;
  if (socket.readyState === WebSocket.CONNECTING) {
    session.earlyBytes += frame.length;
    if (session.earlyBytes > MAX_BUFFERED_BYTES) {
      fail(holder, session, send, "OVERLOADED", "Speech service is not keeping up");
      return;
    }
    session.early.push(frame);
    return;
  }
  if (socket.bufferedAmount > MAX_BUFFERED_BYTES) {
    fail(holder, session, send, "OVERLOADED", "Speech service is not keeping up");
    return;
  }
  socket.send(frame);
}

/** Finish talking. The service answers with the rest of the text, then done. */
export function stopDictation(
  holder: DictationHolder,
  id: string,
  send: Send,
): void {
  const session = current(holder, id, send);
  if (!session || session.stopRequested) return;
  session.stopRequested = true;
  if (session.socket.readyState === WebSocket.OPEN) {
    session.socket.send(JSON.stringify({ type: "stop" }));
  }
}

/** Drop the session without a word. Without an id, whatever is running. */
export function cancelDictation(holder: DictationHolder, id?: string): void {
  const session = holder.dictation;
  if (session && (id === undefined || session.id === id)) end(holder, session);
}

let available = false;

/** Whether browsers should be offered a mic. Kept fresh by the probe. */
export function dictationAvailable(): boolean {
  return available;
}

/**
 * Poll the speech service's health check.
 *
 * Quick while it is down, so a service that is still loading its model shows
 * up within seconds, and slow once it is up. Returns a stop function.
 */
export function startSttProbe(url = config.sttUrl): () => void {
  if (!url) return () => {};
  const health = new URL("/health", url.replace(/^ws/, "http"));
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const check = async () => {
    let ok = false;
    try {
      const res = await fetch(health, { signal: AbortSignal.timeout(3000) });
      ok = res.ok;
    } catch {
      ok = false;
    }
    if (ok !== available) {
      logger.info({ available: ok }, "Speech service availability changed");
    }
    available = ok;
    if (!stopped) {
      timer = setTimeout(check, ok ? 30_000 : 5_000);
      timer.unref();
    }
  };
  void check();
  return () => {
    stopped = true;
    clearTimeout(timer);
    available = false;
  };
}
