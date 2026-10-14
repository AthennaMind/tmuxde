import type { RawData, WebSocket } from "ws";
import { log } from "./log.ts";
import { pcm16ToFloat32, SAMPLE_RATE } from "./pcm.ts";
import type { Segmenter } from "./segmenter.ts";
import type { Transcriber } from "./transcriber.ts";

/** What the service sends. See "Speech service" in PROTOCOL.md. */
export type SttMessage =
  | { type: "ready" }
  | { type: "text"; text: string }
  | { type: "done" }
  | { type: "error"; code: string; message: string };

export type SessionLimits = {
  maxSeconds: number;
  /** Close a session that has sent nothing for this long. */
  idleMs: number;
};

// A piece this short is a click or a breath. Parakeet tends to invent a word
// for it.
const MIN_PIECE_SAMPLES = SAMPLE_RATE / 10;

/**
 * One dictation over one socket.
 *
 * Binary messages are audio. The only text message is `{"type":"stop"}`.
 * The segmenter cuts audio into pieces and each one is decoded as soon as it
 * is complete, so most of a long dictation is text before the user stops.
 * Text goes out in order. After stop the rest is decoded, `done` goes out and
 * the socket closes.
 */
export function runSession(
  ws: WebSocket,
  transcriber: Transcriber,
  segmenter: Segmenter,
  limits: SessionLimits,
): void {
  const maxSamples = limits.maxSeconds * SAMPLE_RATE;
  const startedAt = Date.now();
  let received = 0;
  let decodeMs = 0;
  let stopping = false;
  let finished = false;
  let outcome = "closed";
  let pending: Promise<void> = Promise.resolve();
  let idle: ReturnType<typeof setTimeout> | undefined;

  const send = (msg: SttMessage) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  };

  const finish = (code: number, reason: string) => {
    if (finished) return;
    finished = true;
    stopping = true;
    outcome = reason;
    clearTimeout(idle);
    if (ws.readyState === ws.OPEN) ws.close(code, reason);
  };

  const fail = (code: string, message: string) => {
    send({ type: "error", code, message });
    finish(1011, code);
  };

  const decode = (samples: Float32Array) => {
    if (samples.length < MIN_PIECE_SAMPLES) return;
    pending = pending.then(async () => {
      if (finished) return;
      const begin = performance.now();
      try {
        const text = await transcriber.transcribe(samples);
        if (text) send({ type: "text", text });
      } catch (error) {
        log("error", "Decode failed", { error: String(error) });
        fail("DECODE_FAILED", "Speech could not be transcribed");
      } finally {
        decodeMs += performance.now() - begin;
      }
    });
  };

  const stop = () => {
    if (stopping) return;
    stopping = true;
    clearTimeout(idle);
    for (const piece of segmenter.flush()) decode(piece);
    void pending.then(() => {
      if (finished) return;
      send({ type: "done" });
      finish(1000, "done");
    });
  };

  const touch = () => {
    clearTimeout(idle);
    idle = setTimeout(() => fail("IDLE", "No audio received"), limits.idleMs);
  };

  ws.on("message", (data: RawData, isBinary: boolean) => {
    if (stopping) return;
    touch();
    const bytes = toBytes(data);
    if (!isBinary) {
      let message: unknown;
      try {
        message = JSON.parse(bytes.toString("utf8"));
      } catch {
        message = null;
      }
      if ((message as { type?: unknown } | null)?.type === "stop") stop();
      else fail("BAD_MESSAGE", "Expected audio or stop");
      return;
    }
    const samples = pcm16ToFloat32(bytes);
    if (!samples) {
      fail("BAD_AUDIO", "Audio must be 16-bit PCM");
      return;
    }
    // Past the cap, keep what fits and stop as if asked to.
    const room = maxSamples - received;
    const accepted = samples.length > room ? samples.subarray(0, room) : samples;
    received += accepted.length;
    for (const piece of segmenter.push(accepted)) decode(piece);
    if (received >= maxSamples) stop();
  });

  ws.on("close", () => {
    finished = true;
    stopping = true;
    clearTimeout(idle);
    log("info", "Session closed", {
      audioSeconds: Math.round(received / SAMPLE_RATE),
      decodeMs: Math.round(decodeMs),
      wallMs: Date.now() - startedAt,
      outcome,
    });
  });

  touch();
  send({ type: "ready" });
}

function toBytes(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}
