import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { ClientMessage, ServerMessage } from "@repo/protocol";
import { RelayClient } from "./ws-client";

/**
 * Minimal WebSocket stand-in. Tests drive the lifecycle explicitly (open, auth,
 * close) so reconnect behaviour is deterministic — no timers, no real sockets.
 */
class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  static instances: FakeSocket[] = [];

  readyState = FakeSocket.CONNECTING;
  sent: string[] = [];
  closed = false;

  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(public url: string) {
    FakeSocket.instances.push(this);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.closed = true;
    this.readyState = FakeSocket.CLOSED;
    this.onclose?.();
  }

  /** Complete the handshake and the relay's auth exchange. */
  authenticate() {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
    this.deliver({ type: "auth:success", serverVersion: "test" });
  }

  deliver(msg: ServerMessage) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }

  parsed(): ClientMessage[] {
    return this.sent.map((raw) => JSON.parse(raw) as ClientMessage);
  }

  typesSent(): string[] {
    return this.parsed().map((m) => m.type);
  }
}

const latest = () => FakeSocket.instances[FakeSocket.instances.length - 1]!;

function makeClient(
  overrides: { onMessageDropped?: (n: number) => void } = {},
) {
  return new RelayClient({
    url: "ws://relay.test/_relay",
    token: "t0ken",
    ...overrides,
  });
}

beforeEach(() => {
  FakeSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("disconnect", () => {
  it("detaches handlers so the orphaned socket can't clobber the new status", () => {
    const client = makeClient();
    client.connect();
    const first = latest();
    first.authenticate();
    expect(client.status).toBe("connected");

    // The header's Reconnect button is exactly this pair of calls.
    client.disconnect();
    client.connect();
    const second = latest();
    second.authenticate();

    expect(second).not.toBe(first);
    expect(client.status).toBe("connected");
  });

  it("survives the old socket firing onclose late", () => {
    const client = makeClient();
    client.connect();
    const first = latest();
    first.authenticate();

    client.disconnect();
    client.connect();
    latest().authenticate();

    // A real browser can deliver the orphan's close event after the new socket
    // is already up. With handlers detached this is inert.
    first.onclose?.();
    expect(client.status).toBe("connected");
  });
});

describe("queue policy", () => {
  it("never replays input typed while disconnected", () => {
    const client = makeClient();
    client.connect();
    latest().authenticate();

    client.disconnect();
    client.send({ type: "terminal:input", data: "rm -rf /\r" });
    client.send({ type: "terminal:resize", size: { cols: 10, rows: 5 } });
    client.send({
      type: "file:upload",
      path: "/uploads/photo.png",
      content: "YQ==",
      final: false,
      ack: true,
    });

    client.connect();
    const socket = latest();
    socket.authenticate();

    // Only the auth frame — the ghost keystrokes are gone, which is what makes
    // the "input paused" banner truthful.
    expect(socket.typesSent()).toEqual(["auth"]);
  });

  it("replays idempotent reads once connected", () => {
    const client = makeClient();
    client.send({ type: "session:list" });
    client.send({ type: "file:list", path: "/home" });

    client.connect();
    const socket = latest();
    socket.authenticate();

    expect(socket.typesSent()).toEqual(["auth", "session:list", "file:list"]);
  });

  it("reports the number actually dropped, not the queue length", () => {
    const dropped: number[] = [];
    const client = makeClient({ onMessageDropped: (n) => dropped.push(n) });

    for (let i = 0; i < 53; i++) {
      client.send({ type: "session:list" });
    }

    expect(dropped).toEqual([1, 1, 1]);
  });
});

describe("reconnect", () => {
  it("sends no session:attach of its own", () => {
    // Attach is re-driven by TerminalView's status effect. A queued attach
    // flushed here would race it and respawn the PTY twice.
    const client = makeClient();
    client.connect();
    latest().authenticate();

    client.send({
      type: "session:attach",
      name: "work",
      capture: true,
      attachId: "a1",
    });
    expect(latest().typesSent()).toEqual(["auth", "session:attach"]);

    // Drop the connection and let the backoff timer reconnect.
    latest().close();
    expect(client.status).toBe("reconnecting");
    client.send({ type: "session:attach", name: "work", capture: true });

    vi.advanceTimersByTime(1000);
    const reconnected = latest();
    reconnected.authenticate();

    expect(reconnected.typesSent()).toEqual(["auth"]);
    expect(client.status).toBe("connected");
  });

  it("keeps a single ping interval across reconnects", () => {
    const client = makeClient();
    client.connect();
    const first = latest();
    first.authenticate();
    // A duplicate auth:success on the same socket must not leak an interval.
    first.deliver({ type: "auth:success", serverVersion: "test" });

    first.sent.length = 0;
    vi.advanceTimersByTime(10_000);
    expect(first.typesSent()).toEqual(["ping"]);
  });
});
