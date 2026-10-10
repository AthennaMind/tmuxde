import { describe, it, expect, vi, beforeEach } from "vitest";
import http from "node:http";
import { EventEmitter } from "node:events";
import type { Duplex } from "node:stream";
import type { WebSocketServer } from "ws";
import { attachUpgrade } from "./ws-server.js";

/**
 * `attachUpgrade` decides where every WebSocket upgrade goes on the single port
 * the CLI and `pnpm dev` both serve. Getting the non-relay branch wrong is
 * silent and nasty: Next's HMR socket hangs instead of being answered, and
 * Chromium — which serialises WebSocket handshakes per host — then never even
 * attempts /_relay, so the terminal sits on "Connecting…" forever.
 */
function makeSocket() {
  return { destroy: vi.fn(), write: vi.fn() } as unknown as Duplex & {
    destroy: ReturnType<typeof vi.fn>;
    write: ReturnType<typeof vi.fn>;
  };
}

function makeWss() {
  const wss = new EventEmitter() as unknown as WebSocketServer & {
    handleUpgrade: ReturnType<typeof vi.fn<WebSocketServer["handleUpgrade"]>>;
  };
  wss.handleUpgrade = vi.fn<WebSocketServer["handleUpgrade"]>();
  return wss;
}

let server: http.Server;
let wss: ReturnType<typeof makeWss>;

beforeEach(() => {
  server = new http.Server();
  wss = makeWss();
});

const upgrade = (url: string) => {
  const socket = makeSocket();
  server.emit(
    "upgrade",
    { url, headers: {} } as http.IncomingMessage,
    socket,
    Buffer.alloc(0),
  );
  return socket;
};

describe("attachUpgrade", () => {
  it("routes the relay path to the relay", () => {
    attachUpgrade(server, wss, "/_relay");
    const socket = upgrade("/_relay");

    expect(wss.handleUpgrade).toHaveBeenCalledTimes(1);
    expect(socket.destroy).not.toHaveBeenCalled();
  });

  it("destroys other paths when there is no fallback", () => {
    // Production: the relay is the only thing that upgrades.
    attachUpgrade(server, wss, "/_relay");
    const socket = upgrade("/_next/webpack-hmr");

    expect(socket.destroy).toHaveBeenCalledTimes(1);
    expect(wss.handleUpgrade).not.toHaveBeenCalled();
  });

  it("hands other paths to the fallback when one is given", () => {
    // Single-port dev: Next needs its HMR upgrades to arrive.
    const fallback = vi.fn();
    attachUpgrade(server, wss, "/_relay", fallback);
    const socket = upgrade("/_next/webpack-hmr");

    expect(fallback).toHaveBeenCalledTimes(1);
    expect(socket.destroy).not.toHaveBeenCalled();
    expect(wss.handleUpgrade).not.toHaveBeenCalled();
  });

  it("still keeps the relay path for itself when a fallback exists", () => {
    const fallback = vi.fn();
    attachUpgrade(server, wss, "/_relay", fallback);
    upgrade("/_relay?token=x");

    expect(wss.handleUpgrade).toHaveBeenCalledTimes(1);
    expect(fallback).not.toHaveBeenCalled();
  });
});
