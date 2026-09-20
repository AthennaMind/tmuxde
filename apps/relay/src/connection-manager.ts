import type { WebSocket } from "ws";
import type {
  GrantFiles,
  GrantRecord,
  GrantScope,
  ServerMessage,
  TerminalSize,
} from "@repo/protocol";
import { createLogger } from "@repo/logger";
import { FULL_GRANT } from "./grant.js";
import { destroyClone } from "./tmux-clone.js";
import { deviceIdForTokenId } from "./pairing-local.js";
import { describeUserAgent } from "./user-agent.js";
import type { AccessTransport } from "./access-log.js";
import { sendJson } from "./ws-server.js";
import type { PtyBridge } from "./pty-bridge.js";
import type { DirectoryWatcher, UploadState } from "./file-service.js";
import { cleanupUploads } from "./file-service.js";
import type { RateLimiter } from "./rate-limiter.js";

const logger = createLogger("relay:connections");

export interface ConnectionState {
  id: string;
  ws: WebSocket;
  authenticated: boolean;
  /**
   * What this connection's credential may do.
   *
   * Defaults to `FULL_GRANT` so that a connection which has not authenticated
   * yet is never *narrower* than the code that reads it expects — every read
   * of this is gated behind `authenticated` anyway, and a null here would only
   * add optional-chaining to the paths that must not be wrong.
   */
  grant: GrantRecord;
  pty: PtyBridge | null;
  watchers: Map<string, DirectoryWatcher>;
  uploads: UploadState;
  rateLimiter: RateLimiter;
  attachedSession: string | null;
  /**
   * Last size actually applied to the PTY. Clients emit a burst of fits while
   * layout settles; forwarding every identical size to `pty.resize()` makes tmux
   * redraw globally for every attached client (SIGWINCH), which reads as
   * flicker. Compare against this before resizing.
   */
  lastSize: TerminalSize | null;
  /**
   * The grouped clone this connection is attached *through*, if any.
   *
   * `attachedSession` stays the name of the real session the grant names — it
   * is what every scope and broadcast check compares against — while this is
   * the throwaway tmux session the PTY is actually talking to. Tracked so
   * teardown can destroy it; a clone outliving its connection is a leak.
   */
  cloneSession: string | null;
  activeWindowId: string | null;
  remoteAddress: string | null;
  /**
   * How this socket reached us, as `access-log.transportFor` classified it.
   *
   * Recorded rather than re-derived, because it is not derivable later: a
   * tunnelled connection and a browser on this very machine both arrive from
   * loopback, and the only thing that tells them apart is the tunnel agent's
   * own user-agent header, which exists at upgrade time and nowhere else.
   */
  transport: AccessTransport;
  /** The browser's `user-agent` at upgrade, for naming an unlabelled device. */
  userAgent: string | null;
  /** Display name from the pairing record, once authenticated. */
  label: string | null;
  /**
   * `sessionTokenId()` of the credential this socket authenticated with.
   *
   * Null for the machine's own `AUTH_TOKEN`, which is not revocable — it is
   * the thing revocation is performed *with*. Recorded so a revocation can
   * close exactly this socket and no other; matching on `grant.id` would
   * close every connection sharing `FULL_GRANT`.
   */
  tokenId: string | null;
  /** When the socket was accepted, for "connected 4m ago". */
  connectedAt: number;
  lastActivityAt: number;
  closing: boolean;
  enqueue: (fn: () => Promise<void>) => void;
  drain: () => Promise<void>;
}

const connections = new Map<string, ConnectionState>();
// Per-IP concurrent connection counts, for per-address rate limiting.
const ipCounts = new Map<string, number>();

let nextId = 1;

export function getIpCount(ip: string): number {
  return ipCounts.get(ip) ?? 0;
}

export function createConnection(
  ws: WebSocket,
  rateLimiter: RateLimiter,
  remoteAddress: string | null = null,
): ConnectionState {
  const id = `conn-${nextId++}`;

  // Sequential message queue — prevents concurrent handler races
  const queue: (() => Promise<void>)[] = [];
  let draining = false;
  let closing = false;
  let drainResolvers: (() => void)[] = [];

  const enqueue = (fn: () => Promise<void>) => {
    if (closing) return;
    queue.push(fn);
    if (draining) return;
    draining = true;
    const processQueue = async () => {
      while (queue.length > 0) {
        const next = queue.shift()!;
        try {
          await next();
        } catch (e) {
          logger.error({ err: e, connId: id }, "Queued message handler error");
        }
      }
      draining = false;
      // Resolve any pending drain waiters
      for (const resolve of drainResolvers) resolve();
      drainResolvers = [];
    };
    void processQueue();
  };

  const drain = (): Promise<void> => {
    if (!draining && queue.length === 0) return Promise.resolve();
    return new Promise((resolve) => {
      drainResolvers.push(resolve);
    });
  };

  const conn: ConnectionState = {
    id,
    ws,
    authenticated: false,
    grant: FULL_GRANT,
    pty: null,
    watchers: new Map(),
    uploads: new Map(),
    rateLimiter,
    attachedSession: null,
    lastSize: null,
    cloneSession: null,
    activeWindowId: null,
    remoteAddress,
    transport: "loopback",
    userAgent: null,
    label: null,
    tokenId: null,
    connectedAt: Date.now(),
    lastActivityAt: Date.now(),
    closing: false,
    enqueue,
    drain,
  };

  // Proxy the closing flag
  Object.defineProperty(conn, "closing", {
    get: () => closing,
    set: (v: boolean) => {
      closing = v;
    },
  });
  connections.set(id, conn);
  if (remoteAddress) {
    ipCounts.set(remoteAddress, (ipCounts.get(remoteAddress) ?? 0) + 1);
  }
  logger.info({ connId: id }, "Connection created");
  return conn;
}

export async function removeConnection(conn: ConnectionState): Promise<void> {
  // Clean up PTY (keep tmux session alive)
  if (conn.pty) {
    conn.pty.markDetaching();
    try {
      conn.pty.kill();
    } catch {
      // PTY may already be dead
    }
    conn.pty = null;
  }

  // Destroy the viewing clone, if this connection had one. Must happen after
  // the PTY is dead, or tmux would simply reattach the dying client.
  if (conn.cloneSession) {
    await destroyClone(conn.cloneSession);
    conn.cloneSession = null;
  }

  // Clean up file watchers — await close() so chokidar releases fs handles
  // before we consider the connection fully torn down.
  try {
    await Promise.allSettled(
      Array.from(conn.watchers.values(), (watcher) => watcher.close()),
    );
  } catch {
    // Best-effort — never let watcher teardown block connection removal.
  }
  conn.watchers.clear();

  // Abort in-progress uploads and remove their partial files.
  await cleanupUploads(conn.uploads);

  // Decrement the per-IP connection count.
  if (conn.remoteAddress) {
    const next = (ipCounts.get(conn.remoteAddress) ?? 1) - 1;
    if (next <= 0) ipCounts.delete(conn.remoteAddress);
    else ipCounts.set(conn.remoteAddress, next);
  }

  connections.delete(conn.id);
  logger.info({ connId: conn.id }, "Connection removed");
}

export function getConnectionCount(): number {
  return connections.size;
}

export function getAllConnections(): ConnectionState[] {
  return Array.from(connections.values());
}

/**
 * Close every live socket whose credential was just revoked.
 *
 * 1008 (policy violation) rather than 1000, so the client does not read it as
 * an ordinary close and reconnect. Matched on `tokenId` and never on
 * `grant.id`: `FULL_GRANT` is a single shared record, so a grant-id sweep
 * would disconnect every device on the machine.
 *
 * Returns how many were closed, which is what makes it testable.
 */
export function closeRevokedConnections(tokenIds: Iterable<string>): number {
  const revoked = new Set(tokenIds);
  if (revoked.size === 0) return 0;
  let closed = 0;
  for (const conn of connections.values()) {
    if (conn.tokenId && revoked.has(conn.tokenId)) {
      logger.info({ connId: conn.id }, "Closing revoked connection");
      conn.ws.close(1008, "Access revoked");
      closed++;
    }
  }
  return closed;
}

/**
 * One connected device, as it crosses the loopback control boundary.
 *
 * Deliberately three fields. `connectionSummary` is served over
 * `/_control/devices` to a *different process* — `mtmux status`, `mtmux
 * devices` — and an address or a session name on that endpoint is a fact
 * about what you are working on, handed to anything local that holds the
 * token. `connection-manager.test.ts` pins this and should keep failing for
 * anyone who widens it.
 *
 * The in-process live panel wants more than this and is entitled to it: it
 * runs inside the relay, and nothing it reads leaves. That is
 * `ConnectionDetail` below, and the split is the whole point.
 */
export type ConnectedDevice = {
  label: string;
  connectedAt: number;
  readOnly: boolean;
};

/**
 * One connected socket, for something running inside this process.
 *
 * Never serialise this over the control endpoint. If a future caller needs it
 * across a process boundary, that is a new decision about what a local process
 * holding the token may learn, and it should be made on purpose rather than by
 * reaching for the richer type because it was there.
 */
export type ConnectionDetail = ConnectedDevice & {
  /**
   * The connection's id, which is what `disconnectConnection` takes.
   *
   * Deliberately the socket's id and not the device's: two tabs on one phone
   * are two connections with one device id, and "close that tab" has to be
   * able to mean one of them.
   */
  id: string;
  /** Last message in either direction, for telling live from merely open. */
  lastActivityAt: number;
  /** The tmux session this socket is attached to, or null while it picks one. */
  attachedSession: string | null;
  tokenId: string | null;
  /**
   * The paired device behind the token, when there is one.
   *
   * Null for the machine's own `AUTH_TOKEN` — a browser signed in with the
   * token printed on this screen is not a *paired device*, and offering to
   * revoke it would offer to revoke the machine's own credential.
   */
  deviceId: string | null;
  remoteAddress: string | null;
  scope: ConnectionScope;
  /**
   * What this connection may do to files, as the grant states it.
   *
   * Beside `readOnly` rather than folded into it: they are independent axes,
   * and a share that can watch a session but not touch the disk is a
   * combination somebody has to be able to *see* before they trust it.
   */
  files: GrantFiles;
  /** When the credential stops working, for a share that has an end. */
  expiresAt: number | null;
  /** Last size applied to this socket's PTY — the shape of the viewer's screen. */
  size: TerminalSize | null;
  /** Tunnel, LAN or loopback — see `ConnectionState.transport`. */
  transport: AccessTransport;
  /** Raw `user-agent`, for a reader who wants more than the summary label. */
  userAgent: string | null;
};

/** The shape of a connection's reach, flattened for display. */
export type ConnectionScope =
  | { kind: "all" }
  | { kind: "sessions"; sessions: string[] }
  | { kind: "recordings"; count: number };

/**
 * Who is connected right now.
 *
 * Authenticated connections only. A socket that has opened but not yet proved
 * anything is not a device the user has admitted, and counting it would make
 * the number jump every time a port scanner touched the relay.
 *
 * Deliberately carries no address, no session name and no grant scope: this
 * crosses a loopback HTTP boundary to `mtmux status`, and a device list is not
 * a reason to start handing out the shape of the machine.
 */
export function connectionSummary(): {
  count: number;
  devices: ConnectedDevice[];
} {
  const devices = connectionDetails().map(
    ({ label, connectedAt, readOnly }) => ({ label, connectedAt, readOnly }),
  );
  return { count: devices.length, devices };
}

/**
 * The same connections, in full, for a caller inside this process.
 *
 * Oldest first for the same reason `connectionSummary` is: a live panel that
 * re-sorted on every render would move the row under the user's cursor between
 * pressing the key and the key being handled.
 */
export function connectionDetails(): ConnectionDetail[] {
  return getAllConnections()
    .filter((conn) => conn.authenticated)
    .map((conn) => ({
      id: conn.id,
      // The pairing record's name first, because the user chose it. Then what
      // the browser says it is, which is how a connection that signed in with
      // the machine's own token stops being the third indistinguishable row
      // called "A device".
      label: conn.label ?? describeUserAgent(conn.userAgent) ?? "A device",
      connectedAt: conn.connectedAt,
      readOnly: conn.grant.readOnly,
      lastActivityAt: conn.lastActivityAt,
      attachedSession: conn.attachedSession,
      tokenId: conn.tokenId,
      deviceId: conn.tokenId ? deviceIdForTokenId(conn.tokenId) : null,
      remoteAddress: conn.remoteAddress,
      scope: describeScope(conn.grant.scope),
      files: conn.grant.files,
      expiresAt: conn.grant.expiresAt,
      size: conn.lastSize,
      transport: conn.transport,
      userAgent: conn.userAgent,
    }))
    .sort((a, b) => a.connectedAt - b.connectedAt);
}

function describeScope(scope: GrantScope): ConnectionScope {
  if (scope.kind === "sessions") {
    return { kind: "sessions", sessions: scope.sessions.map((s) => s.name) };
  }
  if (scope.kind === "recordings") {
    return { kind: "recordings", count: scope.recordings.length };
  }
  return { kind: "all" };
}

/**
 * Close one socket, by id, and say whether there was one.
 *
 * Closes rather than revokes, and the difference is the whole of what this is
 * for: the credential stays valid and the browser is free to come back. It is
 * "hang up", not "you are no longer trusted" — for the tab you left open in a
 * cafe, or the one you cannot remember opening. `mtmux devices revoke` is the
 * other answer, and the panel that calls this offers both so nobody reaches
 * for the permanent one to solve a temporary problem.
 *
 * 1000 with a reason rather than a terminate: a clean close lets the browser
 * show why it went instead of reconnecting into a loop.
 */
export async function disconnectConnection(id: string): Promise<boolean> {
  const conn = connections.get(id);
  if (!conn) return false;
  try {
    conn.ws.close(1000, "Closed from the machine");
  } catch {
    // Already gone. `removeConnection` still has to run.
  }
  await removeConnection(conn);
  return true;
}

/**
 * Notified when the set of connected devices changes.
 *
 * Fires on authentication and on close rather than on every socket event —
 * those are the two moments the answer to "who is connected" actually changes.
 */
const connectionListeners = new Set<() => void>();

export function onConnectionsChanged(listener: () => void): () => void {
  connectionListeners.add(listener);
  return () => connectionListeners.delete(listener);
}

export function notifyConnectionsChanged(): void {
  for (const listener of connectionListeners) {
    try {
      listener();
    } catch {
      // A misbehaving display must never take down a connection.
    }
  }
}

/**
 * Send each connection its *own* view of an event, or nothing.
 *
 * This replaces a blanket `broadcastToAll`, which fanned session names to
 * every authenticated connection regardless of scope. That is the single most
 * likely thing in this change to be got wrong, because it is invisible until
 * two browsers with different scopes are connected at the same moment — the
 * ordinary single-user case never shows it.
 *
 * The builder returns null to skip a connection entirely, which is what makes
 * "A's session was killed" reach A and be indistinguishable from silence for
 * B. Returning a *different* message per connection is what makes a filtered
 * `session:list` broadcast possible at all.
 */
export function broadcastWhere(
  build: (conn: ConnectionState) => ServerMessage | null,
  excludeWs?: WebSocket,
): void {
  for (const conn of connections.values()) {
    if (!conn.authenticated) continue;
    if (excludeWs && conn.ws === excludeWs) continue;
    let msg: ServerMessage | null;
    try {
      msg = build(conn);
    } catch (err) {
      // One connection's builder throwing must not silence the others.
      logger.error({ err, connId: conn.id }, "Broadcast builder failed");
      continue;
    }
    if (msg) sendJson(conn.ws, msg);
  }
}

/**
 * Send the same message to everyone.
 *
 * Kept for the handful of events that carry no session-identifying payload.
 * Anything naming a session must go through `broadcastWhere` instead.
 */
export function broadcastToAll(
  msg: ServerMessage,
  excludeWs?: WebSocket,
): void {
  broadcastWhere(() => msg, excludeWs);
}
