import os from "node:os";
import type http from "node:http";
import type { WebSocketServer } from "ws";
import { WebSocket } from "ws";
import { createLogger } from "@repo/logger";
import { tryDeserializeClientMessage } from "@repo/protocol";
import { sendJson } from "./ws-server.js";
import { authenticateMessage, createAuthTimeout } from "./auth.js";
import {
  createConnection,
  removeConnection,
  getAllConnections,
  getConnectionCount,
  getIpCount,
  closeRevokedConnections,
  broadcastWhere,
  notifyConnectionsChanged,
} from "./connection-manager.js";
import { noteApproversChanged, pendingApprovalFor } from "./device-approval.js";
import { admitConnection } from "./connection-gate.js";
import { allowsSession, allowsSessionName } from "./grant.js";
import * as recorder from "./recorder.js";
import { sweepRecordings } from "./recordings-index.js";
import { isCloneSession, sweepOrphanClones } from "./tmux-clone.js";
import { createRateLimiter } from "./rate-limiter.js";
import { createSessionMonitor } from "./session-monitor.js";
import { currentWindowPanes, routeMessage } from "./message-router.js";
import { defaultBrowsePath } from "./file-service.js";
import { deviceIdForTokenId, onSessionTokenRevoked } from "./pairing-local.js";
import * as accessLog from "./access-log.js";
import { config } from "./config.js";

// The `ws` liveness protocol tags each socket with an `isAlive` flag toggled by
// the pong handler; augment the type so it's available without casts.
declare module "ws" {
  interface WebSocket {
    isAlive?: boolean;
  }
}

const logger = createLogger("relay");
const SERVER_VERSION = "1.0.0";

/**
 * Message types this relay understands that the original protocol did not.
 *
 * `SERVER_VERSION` has been "1.0.0" since the first commit and has never been
 * bumped, so it cannot answer "can you do X". This list can, and a client that
 * does not see an entry here falls back to the id-based form that every relay
 * has always understood.
 */
const FEATURES = [
  "window:step",
  "pane:step",
  // One flag for all five `recording:*` messages. They ship as a unit — a
  // client that can list recordings but not fetch one has nothing to offer —
  // so five flags would only create four states nothing ever produces.
  "recording",
];

// Global concurrent-connection cap and per-IP cap. Rejected upgrades are closed
// with 1013 ("Try Again Later"). Sized for a self-hosted single-user tool.
const MAX_CONNECTIONS = 100;
const MAX_CONNECTIONS_PER_IP = 10;

// How often the idle reaper runs; connections with no inbound traffic for
// longer than config.idleTimeoutMinutes are closed.
const IDLE_SWEEP_MS = 60_000;

/**
 * How long a closing socket has to acknowledge before it is terminated.
 *
 * Long enough for a close frame to land on a healthy connection, short enough
 * that a wedged one cannot hold Ctrl+C hostage.
 */
const CLOSE_GRACE_MS = 250;

export type WireOptions = {
  monitor?: ReturnType<typeof createSessionMonitor>;
};

/**
 * Attach all relay protocol handlers (auth, routing, monitoring) to a
 * WebSocketServer. Used by both the standalone relay (apps/relay) and
 * the embedded CLI (apps/cli) which shares one HTTP server with Next.js.
 */
export function wireConnections(
  wss: WebSocketServer,
  opts: WireOptions = {},
): {
  monitor: ReturnType<typeof createSessionMonitor>;
  shutdown: () => void;
} {
  const monitor =
    opts.monitor ??
    createSessionMonitor({
      // Only sessions someone is actually looking at are worth an extra
      // `list-windows` every five seconds.
      watchedSessions: () =>
        Array.from(
          new Set(
            getAllConnections()
              .map((c) => c.attachedSession)
              .filter((n): n is string => !!n),
          ),
        ),
    });

  wss.on("connection", (ws, req?: http.IncomingMessage) => {
    // Behind a proxy on a self-host box the direct peer address is acceptable.
    const remoteAddress = req?.socket?.remoteAddress ?? "unknown";
    const transport = accessLog.transportFor(
      remoteAddress,
      req?.headers?.["user-agent"] ?? null,
    );

    // Enforce global and per-IP concurrent-connection caps before doing any
    // per-connection setup. 1013 = "Try Again Later".
    if (getConnectionCount() >= MAX_CONNECTIONS) {
      logger.warn({ remoteAddress }, "Rejected connection: global cap reached");
      ws.close(1013, "Server at capacity");
      return;
    }
    if (getIpCount(remoteAddress) >= MAX_CONNECTIONS_PER_IP) {
      logger.warn({ remoteAddress }, "Rejected connection: per-IP cap reached");
      ws.close(1013, "Too many connections from your address");
      return;
    }

    const conn = createConnection(ws, createRateLimiter(), remoteAddress);
    // Both are only knowable here, at the upgrade: the request and its headers
    // do not survive into the socket. `transport` in particular cannot be
    // recovered later, because the tunnel agent and a browser on this machine
    // are the same loopback address and differ only by the header above.
    conn.transport = transport;
    conn.userAgent = req?.headers?.["user-agent"] ?? null;

    // ws liveness protocol: mark alive on connect and on every pong.
    ws.isAlive = true;
    ws.on("pong", () => {
      ws.isAlive = true;
    });

    let authTimer: NodeJS.Timeout | null = createAuthTimeout(() => {
      sendJson(ws, { type: "auth:failure", reason: "Authentication timeout" });
      ws.close();
    });

    /**
     * True while a human is being asked about this socket.
     *
     * The gate below is awaited, and a socket is not authenticated until it
     * returns — so without this, a client that sent `auth` twice (or sent
     * anything at all while the question was on screen) would re-enter the
     * unauthenticated branch and raise a second question about itself. Frames
     * that arrive during the wait are dropped rather than queued: nothing said
     * before admission has any standing.
     */
    let admitting = false;

    ws.on("message", async (raw) => {
      const data = raw.toString();
      conn.lastActivityAt = Date.now();

      if (admitting) return;

      if (!conn.rateLimiter.check()) {
        sendJson(ws, {
          type: "error",
          code: "RATE_LIMITED",
          message: "Too many messages",
        });
        return;
      }

      const result = tryDeserializeClientMessage(data);
      if (!result.ok) {
        sendJson(ws, {
          type: "error",
          code: "INVALID_MESSAGE",
          message: result.error,
        });
        return;
      }

      const msg = result.message;

      if (!conn.authenticated) {
        if (authTimer) {
          clearTimeout(authTimer);
          authTimer = null;
        }

        const authResult = authenticateMessage(msg, remoteAddress);
        if (!authResult.authenticated) {
          sendJson(ws, {
            type: "auth:failure",
            reason: authResult.reason ?? "Authentication failed",
          });
          ws.close();
          return;
        }

        /*
         * The credential checked out. That is not the same as somebody being
         * willing to let this device in, and the difference is the whole
         * point of the gate: a token proves what was true when it was issued,
         * and this asks what is true now. See `connection-gate.ts`.
         *
         * Nothing about this machine has been sent yet — no capabilities, no
         * hostname, no session names — so a refusal reveals only that the
         * token was not enough.
         */
        admitting = true;
        const admitted = await admitConnection({
          tokenId: authResult.tokenId ?? null,
          deviceId: authResult.tokenId
            ? deviceIdForTokenId(authResult.tokenId)
            : null,
          label: authResult.label ?? null,
          transport,
          userAgent: conn.userAgent,
        });
        admitting = false;
        if (ws.readyState !== WebSocket.OPEN) return;
        if (!admitted) {
          void accessLog.record({
            at: new Date().toISOString(),
            event: "refused",
            ...accessLog.describeGrant(authResult.grant ?? conn.grant),
            label: authResult.label ?? null,
            transport,
          });
          sendJson(ws, {
            type: "auth:failure",
            reason: "Not approved on the machine",
            // Not a dead credential — see `AuthFailureMessage.code`. Without
            // this the browser reads a refusal as "you have been forgotten",
            // wipes the pairing and asks the user to start again.
            code: "unapproved",
          });
          ws.close();
          return;
        }

        conn.authenticated = true;
        // The grant is always present on a successful result; the fallback
        // exists so a future auth path that forgets to set one cannot silently
        // produce a connection with no policy attached.
        if (authResult.grant) conn.grant = authResult.grant;
        conn.label = authResult.label ?? null;
        conn.tokenId = authResult.tokenId ?? null;
        // Authenticating is the moment a socket becomes a *device*, which is
        // what the CLI's connected line counts.
        notifyConnectionsChanged();

        // Not awaited: a log the machine cannot write must never be able to
        // refuse someone access to their own shell.
        void accessLog.record({
          at: new Date().toISOString(),
          event: "connected",
          ...accessLog.describeGrant(conn.grant),
          label: conn.label,
          transport,
        });

        sendJson(ws, {
          type: "auth:success",
          serverVersion: SERVER_VERSION,
          // Capabilities, so the client can render a read-only banner and hide
          // a file tree that would only ever return ACCESS_DENIED. Advisory —
          // every one of these is enforced server-side regardless.
          capabilities: {
            readOnly: conn.grant.readOnly,
            files: conn.grant.files,
            scope: conn.grant.scope.kind,
          },
          features: FEATURES,
        });
        sendJson(ws, {
          type: "server:info",
          hostname: os.hostname(),
          platform: os.platform(),
          uptime: os.uptime(),
          // Omitted when files are off: it is the home directory path, and
          // handing it to someone who may not list a single file in it leaks
          // the account name for nothing.
          ...(conn.grant.files === "none"
            ? {}
            : { defaultPath: defaultBrowsePath() }),
        });

        // A device asking to be let in *right now* is why this tab was opened.
        //
        // The broadcast that raised the question went out before this socket
        // existed, so without a replay the person who came running because
        // their phone buzzed would find a perfectly ordinary terminal and no
        // way to say yes. The request is time-boxed and carries its own
        // `expiresAt`, so replaying a stale one is not possible.
        const live = pendingApprovalFor(conn);
        if (live) sendJson(ws, live);

        // Heartbeat: standard `ws` liveness protocol. If a peer missed the
        // previous round's pong it's presumed dead and terminated (which fires
        // `close` → removeConnection → PTY/watcher/upload cleanup).
        const pingInterval = setInterval(() => {
          if (ws.readyState !== WebSocket.OPEN) return;
          if (ws.isAlive === false) {
            ws.terminate();
            return;
          }
          ws.isAlive = false;
          ws.ping();
        }, 30_000);
        ws.on("close", () => clearInterval(pingInterval));

        return;
      }

      conn.enqueue(() => routeMessage(conn, msg));
    });

    ws.on("close", async (code, reason) => {
      logger.info(
        { connId: conn.id, code, reason: reason?.toString?.() ?? "" },
        "WS close event",
      );
      if (authTimer) clearTimeout(authTimer);
      conn.closing = true;
      await conn.drain();
      const wasAuthenticated = conn.authenticated;
      if (wasAuthenticated) {
        void accessLog.record({
          at: new Date().toISOString(),
          event: "disconnected",
          ...accessLog.describeGrant(conn.grant),
          label: conn.label,
          transport,
          seconds: Math.round((Date.now() - conn.connectedAt) / 1000),
        });
      }
      await removeConnection(conn);
      if (wasAuthenticated) {
        notifyConnectionsChanged();
        // The last browser that could have answered has closed. Abstain, so
        // the TTY and `mtmux approve` get the question back rather than
        // inheriting a denial nobody made.
        noteApproversChanged();
      }
    });

    ws.on("error", (err) => {
      logger.error({ err, connId: conn.id }, "WebSocket error");
    });
  });

  /**
   * Both monitor events used to bypass the connection manager entirely and
   * iterate `wss.clients`, which meant they were unreachable by any scope
   * check — two of the four broadcast leaks. Routing them through
   * `broadcastWhere` is what makes a session name visible only to connections
   * entitled to know it exists.
   */
  monitor.onSessionExit((name) => {
    if (isCloneSession(name)) return;
    broadcastWhere((conn) => {
      // The connection attached to it already learns from its own PTY exit.
      if (conn.attachedSession === name) return null;
      if (!allowsSessionName(conn.grant, name)) return null;
      return { type: "session:exited", name };
    });
  });

  // A window created, renamed or selected in the user's own terminal has no
  // representation in the PTY byte stream, so without this the browser's tab
  // strip silently rots until re-attach.
  monitor.onWindowsChanged((name, windows) => {
    if (isCloneSession(name)) return;
    broadcastWhere((conn) =>
      conn.attachedSession === name
        ? { type: "window:changed", windows, sessionName: name }
        : null,
    );
    /*
     * The pane layout goes with it, and that is not belt-and-braces.
     *
     * A window listing says *that* something moved; only a pane listing says
     * which pane is now active, how big it is and which one is zoomed. Every
     * client-initiated change already publishes both together through
     * `announceLayout`, so anything that reaches here came from outside the
     * browser — `prefix z`, a split in the user's own terminal, a pane that
     * exited — and those are exactly the cases where the client's picture is
     * the one that goes stale. Sending the window half alone is what left a
     * pane drawn as zoomed after it had been unzoomed on the machine.
     */
    void currentWindowPanes(name)
      .then(({ panes, windowId }) => {
        broadcastWhere((conn) =>
          conn.attachedSession === name
            ? { type: "pane:changed", panes, windowId }
            : null,
        );
      })
      .catch(() => {
        // The session can die between the poll and this listing. The exit path
        // tells the client what happened; a pane list cannot.
      });
  });

  monitor.onSessionCreated((session) => {
    if (isCloneSession(session.name)) return;
    broadcastWhere((conn) =>
      allowsSession(conn.grant, session)
        ? { type: "session:created", session }
        : null,
    );
  });

  monitor.start();

  // Clones are destroyed with their connection, but a crash or `kill -9`
  // skips that. Harmless individually, they accumulate across restarts.
  void sweepOrphanClones().catch(() => {
    // tmux may not be running yet. Nothing to sweep is the normal case.
  });

  // The same argument for recordings, plus one more: a `kill -9` leaves a row
  // claiming to still be recording, and a row that says it is live after a
  // reboot is worse than one that admits it was cut off.
  void sweepRecordings().catch(() => {});

  // Revocation reaper. Dropping the token from the map only stops the next
  // authentication, so without this `mtmux devices revoke` reported success
  // while the revoked socket kept working until it happened to disconnect.
  const stopRevokeSweep = onSessionTokenRevoked(({ tokenIds }) => {
    closeRevokedConnections(tokenIds);
  });

  // Idle reaper: close connections with no inbound traffic for longer than the
  // configured idle timeout. Uses close code 1000 so it reads as a normal close.
  const idleTimeoutMs = config.idleTimeoutMinutes * 60 * 1000;
  const idleSweep = setInterval(() => {
    if (idleTimeoutMs <= 0) return;
    const now = Date.now();
    for (const conn of getAllConnections()) {
      if (now - conn.lastActivityAt > idleTimeoutMs) {
        logger.info({ connId: conn.id }, "Closing idle connection");
        conn.ws.close(1000, "Idle timeout");
      }
    }
  }, IDLE_SWEEP_MS);

  return {
    monitor,
    /**
     * Stop serving, and actually let the process die.
     *
     * `wss.close()` alone does not do that. It stops *accepting* connections
     * and then waits for the existing ones to disconnect on their own — and a
     * connected browser has no reason to. With one tab open, `server.close()`
     * never fired its callback and Ctrl+C hung the CLI forever.
     *
     * So every socket is closed explicitly, and any that has not gone a moment
     * later is terminated. A terminal server is not a database: there is no
     * write to drain, the pty is a child process the OS reaps, and the client
     * reconnects. Waiting politely costs the user a hang and buys nothing.
     */
    shutdown: () => {
      clearInterval(idleSweep);
      stopRevokeSweep();
      monitor.stop();
      // Close the casts before the process goes. Not awaited — shutdown is
      // deliberately not graceful here — but a `stream.end()` in flight is
      // still better than none, and the startup sweep catches what it misses.
      void recorder.stopAll("ended").catch(() => {});
      for (const conn of getAllConnections()) {
        try {
          conn.ws.close(1001, "Server shutting down");
        } catch {
          // Already gone; the terminate below is the backstop.
        }
      }
      const forced = setTimeout(() => {
        for (const conn of getAllConnections()) conn.ws.terminate();
      }, CLOSE_GRACE_MS);
      forced.unref?.();
      wss.close();
    },
  };
}
