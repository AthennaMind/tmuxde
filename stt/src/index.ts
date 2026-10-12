import { lstat, unlink } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import { basename } from "node:path";
import { loadConfig } from "./config.ts";
import { log } from "./log.ts";
import { loadVadSegmenter } from "./segmenter.ts";
import { createSttServer } from "./server.ts";
import { loadParakeet } from "./transcriber.ts";

/**
 * Listen on the unix socket at `path`.
 *
 * A socket file left by a killed service is removed first. Closing `server`
 * removes the file again.
 */
export async function listenOnSocket(server: http.Server, path: string): Promise<void> {
  await removeStaleSocket(path);
  await new Promise<void>((done, fail) => {
    server.once("error", fail);
    server.listen(path, () => {
      server.off("error", fail);
      done();
    });
  });
}

/**
 * Remove a socket file left behind by a killed service.
 *
 * close() removes the file, but SIGKILL or an OOM kill skips it and the next
 * listen fails with EADDRINUSE. Only a socket that refuses connections is
 * removed. A live socket or any other file is an error.
 */
export async function removeStaleSocket(path: string): Promise<void> {
  const stat = await lstat(path).catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") return undefined;
    throw err;
  });
  if (!stat) return;
  if (!stat.isSocket()) throw new Error(`${path} exists and is not a socket`);
  if (await answers(path)) throw new Error(`Something already listens on ${path}`);
  await unlink(path).catch((err: NodeJS.ErrnoException) => {
    if (err.code !== "ENOENT") throw err;
  });
}

/** Whether a process accepts connections on the socket. */
function answers(path: string): Promise<boolean> {
  return new Promise((done, fail) => {
    const socket = net.connect({ path });
    socket.once("connect", () => {
      socket.destroy();
      done(true);
    });
    socket.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ECONNREFUSED" || err.code === "ENOENT") done(false);
      else fail(err);
    });
  });
}

async function main(): Promise<void> {
  const config = loadConfig();
  const model = basename(config.modelDir);
  const loadStart = Date.now();
  const transcriber = await loadParakeet(config.modelDir, config.threads);
  const segmenter = config.vadModel ? await loadVadSegmenter(config.vadModel) : undefined;
  log("info", "Model loaded", {
    model,
    threads: config.threads,
    segments: segmenter ? "utterances" : "30 s chunks",
    ms: Date.now() - loadStart,
  });

  const server = createSttServer({
    transcriber,
    model,
    maxSessions: config.maxSessions,
    segmenter,
    limits: { maxSeconds: config.maxSeconds, idleMs: 60_000 },
  });

  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 2000).unref();
    });
  }

  await listenOnSocket(server, config.socket);
  log("info", "Speech service listening", { socket: config.socket });
}

// Tests import the helpers above without loading a model.
if (import.meta.main) await main();
