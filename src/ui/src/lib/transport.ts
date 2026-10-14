/**
 * The socket seam under RelayClient.
 *
 * RelayClient owns reconnect, backoff, zombie detection and the pending
 * message queue. The transport only moves lines of JSON. `DirectTransport` is
 * a plain WebSocket. Tests pass a fake through the same interface.
 */

export type TransportHandlers = {
  onOpen: () => void;
  onMessage: (text: string) => void;
  onClose: () => void;
};

export interface Transport {
  connect(handlers: TransportHandlers): void;
  send(text: string): void;
  /** Detach handlers and close. A closed transport must never call back. */
  close(): void;
  readonly isOpen: boolean;
  /** Bytes queued locally, for the client's backpressure check. */
  readonly bufferedAmount: number;
}

export type TransportFactory = () => Transport;

/** A plain WebSocket. */
export class DirectTransport implements Transport {
  private ws: WebSocket | null = null;
  private detached = false;

  constructor(private readonly url: string) {}

  connect(handlers: TransportHandlers): void {
    this.detached = false;
    try {
      this.ws = new WebSocket(this.url);
    } catch {
      // Surface a construction failure as a close, so the client's existing
      // reconnect path handles it rather than needing a second error channel.
      handlers.onClose();
      return;
    }
    this.ws.onopen = () => {
      if (!this.detached) handlers.onOpen();
    };
    this.ws.onmessage = (event) => {
      if (!this.detached) handlers.onMessage(event.data as string);
    };
    this.ws.onclose = () => {
      if (!this.detached) handlers.onClose();
    };
    this.ws.onerror = () => {
      // onclose always follows.
    };
  }

  send(text: string): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(text);
  }

  close(): void {
    this.detached = true;
    const ws = this.ws;
    this.ws = null;
    if (!ws) return;
    ws.onopen = null;
    ws.onmessage = null;
    ws.onclose = null;
    ws.onerror = null;
    try {
      ws.close();
    } catch {
      // Already closing or closed.
    }
  }

  get isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  get bufferedAmount(): number {
    return this.ws?.bufferedAmount ?? 0;
  }
}

export function directTransport(url: string): TransportFactory {
  return () => new DirectTransport(url);
}
