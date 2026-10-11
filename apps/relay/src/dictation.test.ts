import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import type { ServerMessage } from "@repo/protocol";
import {
  cancelDictation,
  dictationAvailable,
  feedDictation,
  startDictation,
  startSttProbe,
  stopDictation,
  type DictationHolder,
} from "./dictation.js";

type Received = { binary: Buffer[]; text: string[]; closed: Promise<number> };

/**
 * A stand-in for the speech service: health check plus `/v1/stream`.
 * `onSession` decides how each session behaves.
 */
async function fakeStt(
  onSession: (ws: WebSocket, received: Received) => void = (ws) =>
    ws.send(JSON.stringify({ type: "ready" })),
  health = 200,
) {
  const sessions: Received[] = [];
  const server = http.createServer((req, res) => {
    res.writeHead(req.url === "/health" ? health : 404).end();
  });
  const wss = new WebSocketServer({ server, path: "/v1/stream" });
  wss.on("connection", (ws) => {
    let closed!: (code: number) => void;
    const received: Received = {
      binary: [],
      text: [],
      closed: new Promise((done) => (closed = done)),
    };
    ws.on("message", (data, isBinary) => {
      if (isBinary) received.binary.push(data as Buffer);
      else received.text.push(String(data));
    });
    ws.on("close", (code) => closed(code));
    sessions.push(received);
    onSession(ws, received);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
  cleanups.push(
    () =>
      new Promise<void>((done) => {
        for (const client of wss.clients) client.terminate();
        wss.close();
        server.close(() => done());
      }),
  );
  return { url, sessions };
}

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function client() {
  const holder: DictationHolder = { dictation: null };
  const sent: ServerMessage[] = [];
  const waiters: (() => void)[] = [];
  const send = (msg: ServerMessage) => {
    sent.push(msg);
    for (const wake of waiters.splice(0)) wake();
  };
  /** Resolves once a message of this type has been sent. */
  const until = async (type: ServerMessage["type"]) => {
    while (!sent.some((m) => m.type === type)) {
      await new Promise<void>((wake) => waiters.push(wake));
    }
    return sent.find((m) => m.type === type)!;
  };
  cleanups.push(() => cancelDictation(holder));
  return { holder, sent, send, until };
}

const pcm = (bytes: number[]) => Buffer.from(bytes).toString("base64");

describe("dictation forwarding", () => {
  it("says unavailable when dictation is not configured", () => {
    const { holder, sent, send } = client();
    startDictation(holder, "d1", send, { url: undefined });
    expect(sent).toEqual([
      expect.objectContaining({ type: "dictation:error", id: "d1", code: "UNAVAILABLE" }),
    ]);
    expect(holder.dictation).toBeNull();
  });

  it("says unavailable when the service cannot be reached", async () => {
    const { url } = await fakeStt();
    await cleanups.pop()!();
    const { holder, send, until } = client();
    startDictation(holder, "d1", send, { url });
    expect(await until("dictation:error")).toMatchObject({ code: "UNAVAILABLE" });
    expect(holder.dictation).toBeNull();
  });

  it("forwards audio and stop, then relays text and done", async () => {
    const { url, sessions } = await fakeStt((ws) => {
      ws.send(JSON.stringify({ type: "ready" }));
      ws.on("message", (data, isBinary) => {
        if (isBinary) return;
        ws.send(JSON.stringify({ type: "text", text: "Здравей" }));
        ws.send(JSON.stringify({ type: "done" }));
      });
    });
    const { holder, sent, send, until } = client();
    startDictation(holder, "d1", send, { url });
    await until("dictation:ready");
    feedDictation(holder, "d1", pcm([1, 0, 2, 0]), send);
    stopDictation(holder, "d1", send);
    await until("dictation:done");
    expect(sent).toEqual([
      { type: "dictation:ready", id: "d1" },
      { type: "dictation:text", id: "d1", text: "Здравей" },
      { type: "dictation:done", id: "d1" },
    ]);
    expect(holder.dictation).toBeNull();
    const [session] = sessions;
    expect(Buffer.concat(session!.binary)).toEqual(Buffer.from([1, 0, 2, 0]));
    expect(session!.text).toEqual([JSON.stringify({ type: "stop" })]);
  });

  it("holds audio sent before the service connection opens", async () => {
    const { url, sessions } = await fakeStt();
    const { holder, send, until } = client();
    startDictation(holder, "d1", send, { url });
    feedDictation(holder, "d1", pcm([1, 0]), send);
    feedDictation(holder, "d1", pcm([2, 0]), send);
    stopDictation(holder, "d1", send);
    await until("dictation:ready");
    await new Promise((done) => setTimeout(done, 20));
    expect(sessions[0]!.binary.map((b) => b[0])).toEqual([1, 2]);
    expect(sessions[0]!.text).toEqual([JSON.stringify({ type: "stop" })]);
  });

  it("reports a busy service", async () => {
    const { url } = await fakeStt((ws) => ws.close(1013, "Busy"));
    const { holder, send, until } = client();
    startDictation(holder, "d1", send, { url });
    expect(await until("dictation:error")).toMatchObject({ code: "BUSY" });
    expect(holder.dictation).toBeNull();
  });

  it("passes a service error on as failed", async () => {
    const { url } = await fakeStt((ws) =>
      ws.send(JSON.stringify({ type: "error", code: "DECODE_FAILED", message: "Speech could not be transcribed" })),
    );
    const { holder, send, until } = client();
    startDictation(holder, "d1", send, { url });
    expect(await until("dictation:error")).toEqual({
      type: "dictation:error",
      id: "d1",
      code: "FAILED",
      message: "Speech could not be transcribed",
    });
  });

  it("does not trust malformed service messages", async () => {
    const { url } = await fakeStt((ws) =>
      ws.send(JSON.stringify({ type: "text", text: 42 })),
    );
    const { holder, sent, send, until } = client();
    startDictation(holder, "d1", send, { url });
    expect(await until("dictation:error")).toMatchObject({ code: "FAILED" });
    expect(sent.some((m) => m.type === "dictation:text")).toBe(false);
  });

  it("answers audio for a dictation that is not running", () => {
    const { holder, sent, send } = client();
    feedDictation(holder, "nope", pcm([0, 0]), send);
    expect(sent).toEqual([
      expect.objectContaining({ type: "dictation:error", id: "nope", code: "NOT_FOUND" }),
    ]);
  });

  it("cancels quietly and closes the service session", async () => {
    const { url, sessions } = await fakeStt();
    const { holder, sent, send, until } = client();
    startDictation(holder, "d1", send, { url });
    await until("dictation:ready");
    cancelDictation(holder, "d1");
    expect(await sessions[0]!.closed).toBe(1000);
    expect(holder.dictation).toBeNull();
    expect(sent).toEqual([{ type: "dictation:ready", id: "d1" }]);
  });

  it("ignores a cancel for another dictation", async () => {
    const { url } = await fakeStt();
    const { holder, send, until } = client();
    startDictation(holder, "d2", send, { url });
    await until("dictation:ready");
    cancelDictation(holder, "d1");
    expect(holder.dictation?.id).toBe("d2");
  });

  it("replaces a running dictation when a new one starts", async () => {
    const { url, sessions } = await fakeStt();
    const { holder, send, until } = client();
    startDictation(holder, "d1", send, { url });
    await until("dictation:ready");
    startDictation(holder, "d2", send, { url });
    expect(await sessions[0]!.closed).toBe(1000);
    expect(holder.dictation?.id).toBe("d2");
  });

  it("ends a dictation that runs past its limit", async () => {
    const { url } = await fakeStt();
    const { holder, send, until } = client();
    startDictation(holder, "d1", send, { url, maxSessionMs: 30 });
    expect(await until("dictation:error")).toMatchObject({ code: "FAILED" });
    expect(holder.dictation).toBeNull();
  });
});

describe("speech service probe", () => {
  async function settle(expected: boolean) {
    for (let i = 0; i < 50 && dictationAvailable() !== expected; i++) {
      await new Promise((done) => setTimeout(done, 10));
    }
  }

  it("offers dictation while the service is healthy", async () => {
    const { url } = await fakeStt(undefined, 200);
    const stop = startSttProbe(url);
    await settle(true);
    expect(dictationAvailable()).toBe(true);
    stop();
    expect(dictationAvailable()).toBe(false);
  });

  it("withholds dictation while the service is unhealthy", async () => {
    const { url } = await fakeStt(undefined, 503);
    const stop = startSttProbe(url);
    await new Promise((done) => setTimeout(done, 50));
    expect(dictationAvailable()).toBe(false);
    stop();
  });

  it("does nothing without a configured service", () => {
    const stop = startSttProbe(undefined);
    expect(dictationAvailable()).toBe(false);
    stop();
  });
});
