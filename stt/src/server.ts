import http from "node:http";
import { WebSocketServer } from "ws";
import { chunkSegmenter, type Segmenter } from "./segmenter.ts";
import { runSession, type SessionLimits } from "./session.ts";
import type { Transcriber } from "./transcriber.ts";

export const STREAM_PATH = "/v1/stream";

// 250 ms of 16 kHz PCM16 is 8 KB. Anything near this is not a frame.
const MAX_FRAME_BYTES = 256 * 1024;

export type SttServerOptions = {
  transcriber: Transcriber;
  model: string;
  maxSessions: number;
  limits: SessionLimits;
  /** A fresh segmenter per session. Fixed 30 s chunks unless given. */
  segmenter?: () => Segmenter;
};

/**
 * Health check and one WebSocket route.
 *
 * No authentication of its own. The service publishes no port. The Go server
 * reaches it over a unix socket in the run directory, and has already checked
 * the browser's token, origin and grant before any audio reaches it.
 */
export function createSttServer(options: SttServerOptions): http.Server {
  let active = 0;
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });

  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, model: options.model, sessions: active }));
      return;
    }
    res.writeHead(404).end();
  });

  server.on("upgrade", (req, socket, head) => {
    if (req.url !== STREAM_PATH) {
      socket.end("HTTP/1.1 404 Not Found\r\n\r\n");
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (active >= options.maxSessions) {
        ws.close(1013, "Busy");
        return;
      }
      active += 1;
      ws.on("close", () => {
        active -= 1;
      });
      runSession(
        ws,
        options.transcriber,
        (options.segmenter ?? chunkSegmenter)(),
        options.limits,
      );
    });
  });

  server.on("close", () => {
    for (const client of wss.clients) client.terminate();
    wss.close();
  });

  return server;
}
