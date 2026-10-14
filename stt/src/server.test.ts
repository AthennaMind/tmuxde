import { mkdtemp, rename, rm, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { listenOnSocket } from "./index.ts";
import { createSttServer, STREAM_PATH } from "./server.ts";
import type { SessionLimits, SttMessage } from "./session.ts";
import { serialize, type Transcriber } from "./transcriber.ts";

const servers: http.Server[] = [];
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((s) => new Promise((done) => s.close(done))),
  );
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

/** A short socket path in a fresh directory. Linux allows 107 bytes. */
async function socketPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "stt-"));
  dirs.push(dir);
  return join(dir, "stt.sock");
}

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

type StartOptions = { maxSessions?: number; limits?: Partial<SessionLimits> };

function create(
  transcriber: Transcriber,
  { maxSessions = 4, limits = {} }: StartOptions = {},
): http.Server {
  const server = createSttServer({
    transcriber,
    model: "test-model",
    maxSessions,
    limits: { maxSeconds: 600, idleMs: 5000, ...limits },
  });
  servers.push(server);
  return server;
}

/** Starts a service on a fresh socket and returns the socket path. */
async function start(transcriber: Transcriber, options: StartOptions = {}): Promise<string> {
  const path = await socketPath();
  await listenOnSocket(create(transcriber, options), path);
  return path;
}

/** GET /health over a unix socket. fetch cannot dial one. */
function health(socketPath: string): Promise<{ status?: number; body: unknown }> {
  return new Promise((done, fail) => {
    const req = http.get({ socketPath, path: "/health", agent: false }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => (text += chunk));
      res.on("end", () => done({ status: res.statusCode, body: JSON.parse(text) }));
    });
    req.on("error", fail);
  });
}

/** WebSocket URL for a route on the unix socket at `path`. */
function wsUrl(path: string, route: string): string {
  return `ws+unix://${path}:${route}`;
}

/** Collects everything the service says until it closes the socket. */
function session(path: string) {
  const ws = new WebSocket(wsUrl(path, STREAM_PATH));
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
    const path = await start(counting());
    expect(await health(path)).toEqual({
      status: 200,
      body: { ok: true, model: "test-model", sessions: 0 },
    });
  });

  it("refuses WebSocket upgrades on any other path", async () => {
    const path = await start(counting());
    const ws = new WebSocket(wsUrl(path, "/elsewhere"));
    const error = await new Promise<Error>((done) => ws.on("error", done));
    expect(error.message).toMatch(/404/);
  });

  it("transcribes audio after stop, then says done and closes", async () => {
    const transcriber = counting();
    const path = await start(transcriber);
    const { ws, ready, closed } = session(path);
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
    const path = await start(counting());
    const { ws, ready, closed } = session(path);
    await ready;
    ws.send(silence(0.05));
    ws.send(JSON.stringify({ type: "stop" }));
    const { messages } = await closed;
    expect(messages).toEqual([{ type: "ready" }, { type: "done" }]);
  });

  it("decodes full chunks while audio is still arriving", async () => {
    const transcriber = counting();
    const path = await start(transcriber);
    const { ws, ready, closed } = session(path);
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
    const path = await start(transcriber, { limits: { maxSeconds: 1 } });
    const { ws, ready, closed } = session(path);
    await ready;
    ws.send(silence(1.5));
    const { code, messages } = await closed;
    expect(code).toBe(1000);
    expect(messages.at(-1)).toEqual({ type: "done" });
    expect(transcriber.calls).toEqual([16000]);
  });

  it("rejects audio that is not whole 16-bit samples", async () => {
    const path = await start(counting());
    const { ws, ready, closed } = session(path);
    await ready;
    ws.send(Buffer.alloc(3));
    const { code, messages } = await closed;
    expect(code).toBe(1011);
    expect(messages.at(-1)).toMatchObject({ type: "error", code: "BAD_AUDIO" });
  });

  it("rejects text that is not stop", async () => {
    const path = await start(counting());
    const { ws, ready, closed } = session(path);
    await ready;
    ws.send(JSON.stringify({ type: "start" }));
    const { messages } = await closed;
    expect(messages.at(-1)).toMatchObject({ type: "error", code: "BAD_MESSAGE" });
  });

  it("reports a failed decode", async () => {
    const path = await start({
      transcribe: () => Promise.reject(new Error("native crash")),
    });
    const { ws, ready, closed } = session(path);
    await ready;
    ws.send(silence(1));
    ws.send(JSON.stringify({ type: "stop" }));
    const { messages } = await closed;
    expect(messages.at(-1)).toMatchObject({ type: "error", code: "DECODE_FAILED" });
    expect(JSON.stringify(messages)).not.toContain("native crash");
  });

  it("closes a session that goes quiet", async () => {
    const path = await start(counting(), { limits: { idleMs: 50 } });
    const { ready, closed } = session(path);
    await ready;
    const { messages } = await closed;
    expect(messages.at(-1)).toMatchObject({ type: "error", code: "IDLE" });
  });

  it("turns away sessions over the limit", async () => {
    const path = await start(counting(), { maxSessions: 1 });
    const first = session(path);
    await first.ready;
    expect(await health(path)).toMatchObject({ body: { sessions: 1 } });
    const second = session(path);
    const { code } = await second.closed;
    expect(code).toBe(1013);
    first.ws.close();
    await first.closed;
  });
});

describe("unix socket", () => {
  it("removes a stale socket file before listening", async () => {
    const path = await socketPath();
    // close() removes the file it listened on. Moving the file first leaves
    // a socket nobody listens on, as after SIGKILL.
    const dead = net.createServer();
    await new Promise<void>((done) => dead.listen(`${path}.old`, done));
    await rename(`${path}.old`, path);
    await new Promise((done) => dead.close(done));
    expect((await stat(path)).isSocket()).toBe(true);

    await listenOnSocket(create(counting()), path);
    expect(await health(path)).toMatchObject({ status: 200 });
  });

  it("leaves a socket alone while something listens on it", async () => {
    const path = await socketPath();
    await listenOnSocket(create(counting()), path);

    await expect(listenOnSocket(create(counting()), path)).rejects.toThrow(/already listens/);
    expect(await health(path)).toMatchObject({ status: 200 });
  });

  it("refuses a path that is not a socket", async () => {
    const path = await socketPath();
    await writeFile(path, "keep me");

    await expect(listenOnSocket(create(counting()), path)).rejects.toThrow(/not a socket/);
    expect((await stat(path)).isFile()).toBe(true);
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
