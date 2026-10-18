import {
  serialize,
  tryDeserializeServerMessage,
  type ClientMessage,
  type ServerMessage,
} from "@/protocol";
import { directTransport, type Transport, type TransportFactory } from "./transport";

type MessageHandler = (msg: ServerMessage) => void;
type StatusHandler = (status: "connecting" | "connected" | "reconnecting" | "disconnected") => void;

interface RelayClientOptions {
  /** Ignored when `transport` is supplied. */
  url?: string;
  token: string;
  /** Transfers cannot resume on a new socket. Default true for workspaces. */
  reconnect?: boolean;
  /**
   * How to reach the server. Defaults to a plain WebSocket at `url`. Tests
   * supply a fake.
   */
  transport?: TransportFactory;
  onMessage?: MessageHandler;
  onStatusChange?: StatusHandler;
  onMessageDropped?: (droppedCount: number) => void;
}

const MIN_RECONNECT_DELAY = 1000;
const MAX_RECONNECT_DELAY = 30000;
const MAX_PENDING_MESSAGES = 50;

/** Only context-free reads may wait for a connection. Mutations are dropped. */
const QUEUE_WHEN_DISCONNECTED: ReadonlySet<ClientMessage["type"]> = new Set([
  "session:list",
  "file:list",
  "file:read",
  "file:stat",
]);

function shouldQueue(msg: ClientMessage): boolean {
  return QUEUE_WHEN_DISCONNECTED.has(msg.type);
}

export class RelayClient {
  private transport: Transport | null = null;
  private readonly makeTransport: TransportFactory;
  private token: string;
  private readonly reconnect: boolean;
  private messageHandlers: Set<MessageHandler> = new Set();
  private statusHandlers: Set<StatusHandler> = new Set();
  private reconnectDelay = MIN_RECONNECT_DELAY;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private intentionalClose = false;
  private _status: "connecting" | "connected" | "reconnecting" | "disconnected" = "disconnected";
  private _latency: number | null = null;
  private _reconnectCount = 0;
  // #15: Track last pong for zombie connection detection
  private lastPongAt = 0;
  // #12: Queue messages while disconnected
  private pendingMessages: ClientMessage[] = [];
  /** True between connect() and either auth:success or a close. */
  private connecting = false;
  private onMessageDroppedHandler: ((droppedCount: number) => void) | null = null;

  constructor(options: RelayClientOptions) {
    if (!options.transport && !options.url) {
      throw new Error("RelayClient needs either a url or a transport");
    }
    this.makeTransport = options.transport ?? directTransport(options.url!);
    this.token = options.token;
    this.reconnect = options.reconnect ?? true;
    if (options.onMessage) this.messageHandlers.add(options.onMessage);
    if (options.onStatusChange) this.statusHandlers.add(options.onStatusChange);
    if (options.onMessageDropped) this.onMessageDroppedHandler = options.onMessageDropped;
  }

  get status() {
    return this._status;
  }

  get latency() {
    return this._latency;
  }

  get reconnectCount() {
    return this._reconnectCount;
  }

  private setStatus(status: typeof this._status) {
    this._status = status;
    for (const handler of this.statusHandlers) {
      handler(status);
    }
  }

  connect(): void {
    // Always clear a pending reconnect timer first so a queued reconnect can't
    // fire a second connect() and open a parallel socket (e.g. the `online`
    // event handler and a scheduled reconnect racing each other).
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    // Guard: if a transport is already connecting or open, don't open another.
    // This makes concurrent connect() calls idempotent.
    if (this.connecting) return;

    // Tear down any previous (closing/closed) transport so its stale handlers —
    // especially onClose — can't schedule another reconnect against us or
    // deliver messages onto the new connection.
    if (this.transport) {
      this.transport.close();
      this.transport = null;
    }

    this.intentionalClose = false;
    this.connecting = true;
    this.setStatus(this._reconnectCount > 0 ? "reconnecting" : "connecting");

    const transport = this.makeTransport();
    this.transport = transport;

    transport.connect({
      onOpen: () => {
        // Send auth immediately.
        this.sendRaw(serialize({ type: "auth", token: this.token }));
      },
      onMessage: (data) => this.handleMessage(data),
      onClose: () => {
        this.connecting = false;
        this.stopPing();
        if (!this.intentionalClose && this.reconnect) {
          this.setStatus("reconnecting");
          this.scheduleReconnect();
        } else {
          this.setStatus("disconnected");
        }
      },
    });
  }

  private handleMessage(data: string): void {
    const result = tryDeserializeServerMessage(data);
    if (!result.ok) return;

    const msg = result.message;

    if (msg.type === "auth:success") {
      this.connecting = false;
      this.setStatus("connected");
      this.reconnectDelay = MIN_RECONNECT_DELAY;
      this._reconnectCount = 0;
      this.startPing();
      this.flushPendingMessages();
    }

    if (msg.type === "auth:failure") {
      this.intentionalClose = true;
      this.connecting = false;
      this.transport?.close();
      this.transport = null;
      this.setStatus("disconnected");
    }

    if (msg.type === "pong") {
      this._latency = Date.now() - msg.timestamp;
      this.lastPongAt = Date.now();
    }

    for (const handler of this.messageHandlers) {
      handler(msg);
    }
  }

  disconnect(): void {
    this.intentionalClose = true;
    this.connecting = false;
    this.stopPing();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    // Transports detach their handlers on close. Merely closing the underlying
    // socket would leave an orphan whose late onClose still runs and re-emits a
    // status — enough to knock a freshly reconnected client back to
    // "reconnecting", after which send() silently queues forever.
    this.transport?.close();
    this.transport = null;
    this.setStatus("disconnected");
  }

  send(msg: ClientMessage): void {
    // Only send once the relay has confirmed auth (status === "connected").
    // The WS readyState becomes OPEN at handshake — before auth:success — so
    // sending here would race the auth handler and get dropped by the relay.
    if (this.transport?.isOpen && this._status === "connected") {
      this.transport.send(serialize(msg));
      return;
    }
    if (!shouldQueue(msg)) return;
    this.pendingMessages.push(msg);
    if (this.pendingMessages.length > MAX_PENDING_MESSAGES) {
      const dropped = this.pendingMessages.length - MAX_PENDING_MESSAGES;
      this.pendingMessages.splice(0, dropped);
      // Report how many were actually discarded — this used to pass the
      // post-trim queue length, so the toast always said "50".
      this.onMessageDroppedHandler?.(dropped);
    }
  }

  /**
   * Try again right now, on a fresh ladder.
   *
   * For the moments when something outside the client knows more than the
   * backoff does — the network came back, or the user returned to the tab.
   * Plain `connect()` is not enough on its own: it cancels the pending timer
   * but leaves `reconnectDelay` wherever the ladder had climbed to, so the
   * *next* failure resumes at thirty seconds and the user is back to waiting
   * out a timer that no longer describes the situation.
   */
  reconnectNow(): void {
    if (this.intentionalClose) return;
    this.reconnectDelay = MIN_RECONNECT_DELAY;
    this.connect();
  }

  onMessage(handler: MessageHandler): () => void {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  onStatusChange(handler: StatusHandler): () => void {
    this.statusHandlers.add(handler);
    return () => this.statusHandlers.delete(handler);
  }

  private sendRaw(data: string): void {
    this.transport?.send(data);
  }

  private scheduleReconnect(): void {
    if (this.intentionalClose) return;

    this._reconnectCount++;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.reconnectDelay);

    this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_RECONNECT_DELAY);
  }

  private startPing(): void {
    // Idempotent — a duplicate auth:success on one socket would otherwise leak
    // an interval.
    this.stopPing();
    this.lastPongAt = Date.now();
    this.pingTimer = setInterval(() => {
      // #15: Zombie detection — if missed 2+ pongs (>25s), force reconnect
      if (this.lastPongAt && Date.now() - this.lastPongAt > 25000) {
        this.dropConnection();
        return;
      }
      // Close if send buffer is backed up (>1MB)
      if (this.transport && this.transport.bufferedAmount > 1_048_576) {
        this.dropConnection();
        return;
      }
      this.send({ type: "ping", timestamp: Date.now() });
    }, 10000);
  }

  /**
   * Kill the current connection so the reconnect path picks it up. The
   * transport detaches its own handlers, so this synthesises the close the
   * client would otherwise wait for.
   */
  private dropConnection(): void {
    this.transport?.close();
    this.transport = null;
    this.connecting = false;
    this.stopPing();
    this.setStatus("reconnecting");
    this.scheduleReconnect();
  }

  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private flushPendingMessages(): void {
    const messages = this.pendingMessages.splice(0);
    for (const msg of messages) {
      this.send(msg);
    }
  }
}
