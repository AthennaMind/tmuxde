import type { AddressInfo } from "node:net";
import type http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { createSttServer, STREAM_PATH } from "./server.ts";
import type { SessionLimits, SttMessage } from "./session.ts";
import { serialize, type Transcriber } from "./transcriber.ts";

const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((s) => new Promise((done) => s.close(done))),
  );
});

/** Names each decode by its sample count, so tests can see the chunking. */
function counting(): Transcriber & { calls: number[] } {
  const calls: number[] = [];
  return {
    calls,
    async transcribe(samples) {
      calls.push(samples.length);
      return `samples ${samples.length}`;
    },
  };
}

async function start(
  transcriber: Transcriber,
  { maxSessions = 4, limits = {} }: { maxSessions?: number; limits?: Partial<SessionLimits> } = {},
): Promise<string> {
  const server = createSttServer({
    transcriber,
    model: "test-model",
    maxSessions,
    limits: { maxSeconds: 600, idleMs: 5000, ...limits },
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return `127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** Collects everything the service says until it closes the socket. */
function session(host: string) {
  const ws = new WebSocket(`ws://${host}${STREAM_PATH}`);
  const messages: SttMessage[] = [];
  const closed = new Promise<{ code: number; messages: SttMessage[] }>((done) => {
    ws.on("close", (code) => done({ code, messages }));
  });
  const ready = new Promise<void>((done, fail) => {
    ws.on("message", (data) => {
      const msg = JSON.parse(String(data)) as SttMessage;
      messages.push(msg);
      if (msg.type === "ready") done();
    });
    ws.on("error", fail);
  });
  return { ws, ready, closed };
}

function silence(seconds: number): Buffer {
  return Buffer.alloc(Math.round(seconds * 16000) * 2);
}

describe("speech service", () => {
  it("answers health checks with the model name", async () => {
    const host = await start(counting());
    const res = await fetch(`http://${host}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, model: "test-model", sessions: 0 });
  });

  it("refuses WebSocket upgrades on any other path", async () => {
    const host = await start(counting());
    const ws = new WebSocket(`ws://${host}/elsewhere`);
    const error = await new Promise<Error>((done) => ws.on("error", done));
    expect(error.message).toMatch(/404/);
  });

  it("transcribes audio after stop, then says done and closes", async () => {
    const transcriber = counting();
    const host = await start(transcriber);
    const { ws, ready, closed } = session(host);
    await ready;
    ws.send(silence(0.5));
    ws.send(silence(0.5));
    ws.send(JSON.stringify({ type: "stop" }));
    const { code, messages } = await closed;
    expect(code).toBe(1000);
    expect(messages).toEqual([
      { type: "ready" },
      { type: "text", text: "samples 16000" },
      { type: "done" },
    ]);
  });

  it("skips a tail too short to be speech", async () => {
    const host = await start(counting());
    const { ws, ready, closed } = session(host);
    await ready;
    ws.send(silence(0.05));
    ws.send(JSON.stringify({ type: "stop" }));
    const { messages } = await closed;
    expect(messages).toEqual([{ type: "ready" }, { type: "done" }]);
  });

  it("decodes full chunks while audio is still arriving", async () => {
    const transcriber = counting();
    const host = await start(transcriber);
    const { ws, ready, closed } = session(host);
    await ready;
    for (let i = 0; i < 31; i++) ws.send(silence(1));
    ws.send(JSON.stringify({ type: "stop" }));
    const { messages } = await closed;
    const texts = messages.filter((m) => m.type === "text");
    expect(texts).toHaveLength(2);
    // Two chunks, nothing lost or repeated at the cut.
    expect(transcriber.calls.reduce((a, b) => a + b, 0)).toBe(31 * 16000);
    expect(transcriber.calls[0]).toBeLessThanOrEqual(30 * 16000);
  });

  it("stops by itself at the length limit and keeps what fits", async () => {
    const transcriber = counting();
    const host = await start(transcriber, { limits: { maxSeconds: 1 } });
    const { ws, ready, closed } = session(host);
    await ready;
    ws.send(silence(1.5));
    const { code, messages } = await closed;
    expect(code).toBe(1000);
    expect(messages.at(-1)).toEqual({ type: "done" });
    expect(transcriber.calls).toEqual([16000]);
  });

  it("rejects audio that is not whole 16-bit samples", async () => {
    const host = await start(counting());
    const { ws, ready, closed } = session(host);
    await ready;
    ws.send(Buffer.alloc(3));
    const { code, messages } = await closed;
    expect(code).toBe(1011);
    expect(messages.at(-1)).toMatchObject({ type: "error", code: "BAD_AUDIO" });
  });

  it("rejects text that is not stop", async () => {
    const host = await start(counting());
    const { ws, ready, closed } = session(host);
    await ready;
    ws.send(JSON.stringify({ type: "start" }));
    const { messages } = await closed;
    expect(messages.at(-1)).toMatchObject({ type: "error", code: "BAD_MESSAGE" });
  });

  it("reports a failed decode", async () => {
    const host = await start({
      transcribe: () => Promise.reject(new Error("native crash")),
    });
    const { ws, ready, closed } = session(host);
    await ready;
    ws.send(silence(1));
    ws.send(JSON.stringify({ type: "stop" }));
    const { messages } = await closed;
    expect(messages.at(-1)).toMatchObject({ type: "error", code: "DECODE_FAILED" });
    expect(JSON.stringify(messages)).not.toContain("native crash");
  });

  it("closes a session that goes quiet", async () => {
    const host = await start(counting(), { limits: { idleMs: 50 } });
    const { ready, closed } = session(host);
    await ready;
    const { messages } = await closed;
    expect(messages.at(-1)).toMatchObject({ type: "error", code: "IDLE" });
  });

  it("turns away sessions over the limit", async () => {
    const host = await start(counting(), { maxSessions: 1 });
    const first = session(host);
    await first.ready;
    const second = session(host);
    const { code } = await second.closed;
    expect(code).toBe(1013);
    first.ws.close();
  });
});

describe("serialize", () => {
  it("runs one decode at a time in arrival order", async () => {
    const order: string[] = [];
    let running = 0;
    const transcriber = serialize(async (samples) => {
      running += 1;
      expect(running).toBe(1);
      order.push(`start ${samples.length}`);
      await new Promise((done) => setTimeout(done, 5));
      order.push(`end ${samples.length}`);
      running -= 1;
      return "";
    });
    await Promise.all([
      transcriber.transcribe(new Float32Array(1)),
      transcriber.transcribe(new Float32Array(2)),
    ]);
    expect(order).toEqual(["start 1", "end 1", "start 2", "end 2"]);
  });

  it("keeps going after a failure", async () => {
    let calls = 0;
    const transcriber = serialize(async () => {
      calls += 1;
      if (calls === 1) throw new Error("first fails");
      return "second";
    });
    await expect(transcriber.transcribe(new Float32Array(1))).rejects.toThrow();
    await expect(transcriber.transcribe(new Float32Array(1))).resolves.toBe("second");
  });
});
