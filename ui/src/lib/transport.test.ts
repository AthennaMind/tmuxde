import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { DirectTransport } from "./transport";

/** Minimal WebSocket stand-in the tests drive by hand. */
class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeSocket[] = [];

  readyState = FakeSocket.CONNECTING;
  bufferedAmount = 0;
  sent: string[] = [];
  closed = false;

  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
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

  open() {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }

  deliver(msg: unknown) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }

  parsed() {
    return this.sent.map((s) => JSON.parse(s) as Record<string, unknown>);
  }
}

const latest = () => FakeSocket.instances[FakeSocket.instances.length - 1]!;

function handlers() {
  const opened: number[] = [];
  const messages: string[] = [];
  const closes: number[] = [];
  return {
    onOpen: () => opened.push(1),
    onMessage: (t: string) => messages.push(t),
    onClose: () => closes.push(1),
    opened,
    messages,
    closes,
  };
}

beforeEach(() => {
  FakeSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeSocket);
});

afterEach(() => vi.unstubAllGlobals());

describe("DirectTransport", () => {
  it("passes text straight through in both directions", () => {
    const h = handlers();
    const t = new DirectTransport("ws://relay.test/_relay");
    t.connect(h);
    latest().open();
    expect(h.opened).toHaveLength(1);

    t.send("hello");
    expect(latest().sent).toEqual(["hello"]);

    latest().onmessage?.({ data: "world" });
    expect(h.messages).toEqual(["world"]);
  });

  it("drops sends before the socket is open", () => {
    const t = new DirectTransport("ws://relay.test/_relay");
    t.connect(handlers());
    t.send("too early");
    expect(latest().sent).toEqual([]);
  });

  it("detaches on close so a late event cannot call back", () => {
    const h = handlers();
    const t = new DirectTransport("ws://relay.test/_relay");
    t.connect(h);
    const ws = latest();
    ws.open();

    t.close();
    // A real browser can still deliver these after close().
    ws.onclose?.();
    ws.onmessage?.({ data: "ghost" });
    expect(h.closes).toHaveLength(0);
    expect(h.messages).toEqual([]);
  });

  it("reports a construction failure as a close", () => {
    vi.stubGlobal(
      "WebSocket",
      class {
        constructor() {
          throw new Error("blocked");
        }
      },
    );
    const h = handlers();
    new DirectTransport("ws://relay.test/_relay").connect(h);
    expect(h.closes).toHaveLength(1);
  });

  it("exposes the socket's buffered amount for backpressure", () => {
    const t = new DirectTransport("ws://relay.test/_relay");
    t.connect(handlers());
    latest().open();
    latest().bufferedAmount = 4096;
    expect(t.bufferedAmount).toBe(4096);
  });
});
