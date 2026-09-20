import { open, stat } from "node:fs/promises";

import type { WebSocket } from "ws";
import type {
  ClientMessage,
  RecordingInfo,
  ServerMessage,
  SessionInfo,
  PaneInfo,
} from "@repo/protocol";
import { createLogger } from "@repo/logger";
import { sendJson } from "./ws-server.js";
import type { ConnectionState } from "./connection-manager.js";
import { broadcastWhere } from "./connection-manager.js";
import {
  allowsRecording,
  allowsSession,
  allowsSessionName,
  isFullGrant,
} from "./grant.js";
import { enforce } from "./policy.js";
import { createPtyBridge } from "./pty-bridge.js";
import {
  createReadOnlyClone,
  destroyClone,
  isCloneSession,
} from "./tmux-clone.js";
import * as tmux from "./tmux-manager.js";
import * as files from "./file-service.js";
import * as recorder from "./recorder.js";
import * as recordings from "./recordings-index.js";
import { resolveDeviceApproval } from "./device-approval.js";
const logger = createLogger("relay:router");

// Output backpressure thresholds. If the socket's send buffer grows past the
// high-water mark (a slow/stalled client on a fast-producing PTY) we pause the
// PTY, then resume once the buffer drains back below the low-water mark. This
// bounds the relay's heap growth on fast producers.
const OUTPUT_HIGH_WATER = 8 * 1024 * 1024; // 8 MiB
const OUTPUT_LOW_WATER = 1 * 1024 * 1024; // 1 MiB
const DRAIN_POLL_MS = 50;

function send(ws: WebSocket, msg: ServerMessage): void {
  sendJson(ws, msg);
}

function sendError(ws: WebSocket, code: string, message: string): void {
  send(ws, { type: "error", code, message });
}

/** Publish where the attached pane's view sits — see `tmux:scroll-state`. */
function sendScrollState(ws: WebSocket, state: tmux.ScrollState): void {
  send(ws, {
    type: "tmux:scroll-state",
    position: state.inMode ? state.position : 0,
    historySize: state.historySize,
    paneHeight: state.paneHeight,
    inMode: state.inMode,
  });
}

/** How much of a recording one `recording:chunk` carries. */
const RECORDING_CHUNK_BYTES = 64 * 1024;

/**
 * Recordings this connection may see.
 *
 * A full grant sees every recording on the machine. A recordings-scoped grant
 * sees exactly the ones it names. A sessions-scoped grant sees none: sharing a
 * live session was never sharing its history.
 */
async function visibleRecordings(
  conn: ConnectionState,
): Promise<RecordingInfo[]> {
  const all = await recordings.list();
  const live = new Map(recorder.listActive().map((r) => [r.id, r]));
  return all
    .map((r) => live.get(r.id) ?? r)
    .filter((r) => allowsRecording(conn.grant, r.id));
}

async function visibleRecording(
  conn: ConnectionState,
  id: string,
): Promise<RecordingInfo | null> {
  if (!allowsRecording(conn.grant, id)) return null;
  return recordings.get(id);
}

/**
 * Send a recording's bytes as a run of `recording:chunk` messages.
 *
 * Read in 64 KiB slices and base64'd, mirroring `file:upload` in reverse. The
 * websocket is the transport rather than HTTP because the case this feature
 * exists for — a phone on cellular — is the *tunnelled* case, where the relay
 * has no HTTP route at all and `resolveRelayHttpBase()` in the web app returns
 * `""`. `GET /recording` is a LAN fast path, not the mechanism.
 *
 * Exactly one chunk carries `final: true`, including for an empty file, so a
 * client always has a termination signal to wait for.
 */
async function streamRecording(
  ws: WebSocket,
  recording: RecordingInfo,
  offset: number,
): Promise<void> {
  const path = recordings.recordingPath(recording.filename);

  let total: number;
  try {
    total = (await stat(path)).size;
  } catch {
    sendError(ws, "NOT_FOUND", "Recording not found");
    return;
  }

  const handle = await open(path, "r");
  try {
    let position = Math.min(offset, total);
    const buffer = Buffer.allocUnsafe(RECORDING_CHUNK_BYTES);

    do {
      const { bytesRead } = await handle.read(
        buffer,
        0,
        RECORDING_CHUNK_BYTES,
        position,
      );
      const final = position + bytesRead >= total;
      send(ws, {
        type: "recording:chunk",
        id: recording.id,
        offset: position,
        data: buffer.subarray(0, bytesRead).toString("base64"),
        totalBytes: total,
        final,
      });
      position += bytesRead;
      if (final) break;
    } while (position < total);
  } finally {
    await handle.close();
  }
}

/**
 * Sessions this connection is allowed to know exist.
 *
 * Clones are stripped for *everyone*, scoped or not: they are relay plumbing,
 * and one showing up in the owner's own session list is a bug.
 */
async function sessionsVisibleTo(
  conn: ConnectionState,
): Promise<SessionInfo[]> {
  const all = await tmux.listSessions();
  const real = all.filter((s) => !isCloneSession(s.name));
  if (isFullGrant(conn.grant)) return real;
  return real.filter((s) => allowsSession(conn.grant, s));
}

/** Would this connection be allowed to see an event about `name`? */
function canSee(conn: ConnectionState, name: string): boolean {
  if (isCloneSession(name)) return false;
  // Name-matched, because a broadcast about a killed session has no id left
  // to resolve. See `allowsSessionName` for why that is safe here and would
  // not be for an access check.
  return allowsSessionName(conn.grant, name);
}

/**
 * The panes of the window the session is *actually showing*, plus that
 * window's id.
 *
 * Every pane reply used to be built from `listPanes(session)` — an unscoped
 * listing of every pane in every window — and then guessed the current window
 * with `panes.find(p => p.active)?.windowId`. `#{pane_active}` is scoped to its
 * own window, so that guess always resolved to the *first* window, whatever
 * window the user was looking at. Asking tmux for the window id directly and
 * scoping the listing to it is the fix: one reply now describes exactly one
 * window, the one on screen.
 */
async function currentWindowPanes(
  session: string,
): Promise<{ panes: PaneInfo[]; windowId: string }> {
  const windowId = await tmux.currentWindowId(session);
  const panes = await tmux.listPanes(session, windowId);
  return { panes, windowId };
}

/**
 * Publish the session's window list and current pane layout.
 *
 * Both go to the sender *and* to every other connection attached to the same
 * session: tmux state is shared, so a second viewer that never hears about a
 * window switch is showing a stale tab strip over a screen that has already
 * moved.
 */
async function announceLayout(
  conn: ConnectionState,
  session: string,
): Promise<{ panes: PaneInfo[]; windowId: string }> {
  const windows = await tmux.listWindows(session);
  const layout = await currentWindowPanes(session);
  const windowMsg: ServerMessage = {
    type: "window:changed",
    windows,
    sessionName: session,
  };
  const paneMsg: ServerMessage = {
    type: "pane:changed",
    panes: layout.panes,
    windowId: layout.windowId,
  };
  send(conn.ws, windowMsg);
  send(conn.ws, paneMsg);
  broadcastWhere(
    (other) => (other.attachedSession === session ? windowMsg : null),
    conn.ws,
  );
  broadcastWhere(
    (other) => (other.attachedSession === session ? paneMsg : null),
    conn.ws,
  );
  return layout;
}

export async function routeMessage(
  conn: ConnectionState,
  msg: ClientMessage,
): Promise<void> {
  const { ws } = conn;

  // The single gate. Everything below assumes it has already run: read-only,
  // file level, session scope, and — for every grant, including full ones —
  // that a pane or window id names something inside the attached session.
  const verdict = await enforce(
    { grant: conn.grant, attachedSession: conn.attachedSession },
    msg,
  );
  if (!verdict.ok) {
    sendError(ws, verdict.code, verdict.message);
    return;
  }

  try {
    switch (msg.type) {
      case "ping":
        send(ws, { type: "pong", timestamp: msg.timestamp });
        break;

      case "session:list": {
        // Filtered, never refused. A scoped holder asking what exists gets
        // their own sessions; an error here would tell them there is more.
        send(ws, {
          type: "session:list",
          sessions: await sessionsVisibleTo(conn),
        });
        break;
      }

      case "session:create": {
        const session = await tmux.createSession(
          msg.name,
          msg.cwd,
          msg.command,
        );
        send(ws, { type: "session:created", session });
        broadcastWhere(
          (other) =>
            canSee(other, session.name)
              ? { type: "session:created", session }
              : null,
          ws,
        );
        break;
      }

      case "session:attach": {
        // Detach existing PTY first. `attachedSession` must be cleared with it:
        // every step below can fail, and leaving the old name in place would
        // point pane/window/interrupt handlers at a session this connection is
        // no longer attached to.
        if (conn.pty) {
          conn.pty.markDetaching();
          try {
            conn.pty.kill();
          } catch {
            /* ignore */
          }
          conn.pty = null;
        }
        conn.attachedSession = null;
        conn.lastSize = null;
        if (conn.cloneSession) {
          await destroyClone(conn.cloneSession);
          conn.cloneSession = null;
        }

        // A clone is never a legitimate attach target, whatever the grant.
        const exists =
          !isCloneSession(msg.name) && (await tmux.sessionExists(msg.name));
        if (!exists) {
          sendError(ws, "SESSION_NOT_FOUND", `Session "${msg.name}" not found`);
          break;
        }

        // Capture pane content BEFORE creating the PTY bridge, but never let a
        // capture failure abort the attach — the old PTY is already dead at this
        // point, so throwing here would leave the client with a dead terminal
        // and no way to recover. Degrade to no replay instead.
        let captured: string | null = null;
        if (msg.capture) {
          try {
            captured = await tmux.capturePane(msg.name);
          } catch (err) {
            logger.warn(
              { err, session: msg.name },
              "capture-pane failed; attaching without scrollback replay",
            );
          }
        }

        /**
         * A read-only grant never attaches to the target directly.
         *
         * `attach-session -r` is not a boundary on its own — tmux keeps
         * `detach-client` and `switch-client` live under `-r`, and `(` / `)`
         * are bound to `switch-client` by default, so a viewer could page
         * through every session on the machine. The clone carries no prefix
         * and an empty key table, which is what makes the refusal total.
         */
        let attachTarget = msg.name;
        if (conn.grant.readOnly) {
          try {
            attachTarget = await createReadOnlyClone(
              msg.name,
              conn.grant.id,
              conn.id,
            );
            conn.cloneSession = attachTarget;
          } catch (err) {
            logger.error({ err, session: msg.name }, "Clone creation failed");
            // Refuse rather than fall back to a direct attach: falling back
            // would silently turn a read-only share into an escapable one.
            sendError(ws, "ATTACH_FAILED", "Could not open a read-only view.");
            break;
          }
        }

        const bridge = createPtyBridge(attachTarget, msg.size, {
          readOnly: conn.grant.readOnly,
        });
        if (bridge.spawnError) {
          if (conn.cloneSession) {
            await destroyClone(conn.cloneSession);
            conn.cloneSession = null;
          }
          sendError(ws, "PTY_SPAWN_FAILED", bridge.spawnError.message);
          break;
        }
        conn.pty = bridge;
        // The *real* session name, not the clone's. Every scope check and
        // broadcast compares against this, and they must all speak about the
        // session the grant actually names.
        conn.attachedSession = msg.name;
        conn.lastSize = msg.size ?? null;

        // Bind callbacks to *this* bridge instance. A previous PTY's late
        // onExit must not null out conn.pty if it has already been reassigned
        // to a newer bridge — only clear if conn.pty still points at us.
        let paused = false;
        let drainTimer: NodeJS.Timeout | null = null;
        bridge.onData((data) => {
          if (conn.pty !== bridge) {
            if (drainTimer) {
              clearInterval(drainTimer);
              drainTimer = null;
            }
            return;
          }
          send(ws, { type: "terminal:output", data });

          // Apply backpressure: pause the PTY while the client's send buffer is
          // backed up, resume once it drains below the low-water mark.
          if (!paused && ws.bufferedAmount > OUTPUT_HIGH_WATER) {
            paused = true;
            bridge.pause();
            drainTimer = setInterval(() => {
              // Bridge was replaced/closed — stop polling and release.
              if (conn.pty !== bridge) {
                if (drainTimer) {
                  clearInterval(drainTimer);
                  drainTimer = null;
                }
                return;
              }
              if (ws.bufferedAmount <= OUTPUT_LOW_WATER) {
                paused = false;
                if (drainTimer) {
                  clearInterval(drainTimer);
                  drainTimer = null;
                }
                bridge.resume();
              }
            }, DRAIN_POLL_MS);
          }
        });

        bridge.onExit((exitCode) => {
          send(ws, { type: "session:exited", name: msg.name, exitCode });
          if (conn.pty === bridge) {
            conn.pty = null;
            conn.attachedSession = null;
            conn.lastSize = null;
          }
        });

        bridge.onSpawnError((err) => {
          sendError(ws, "PTY_SPAWN_FAILED", err.message);
          if (conn.pty === bridge) {
            conn.pty = null;
            conn.attachedSession = null;
            conn.lastSize = null;
          }
        });

        // Ack FIRST, then replay. The client drops terminal:output until it has
        // seen session:attached, so sending the capture ahead of the ack meant
        // it was always discarded and the first paint was blank.
        bridge.onReady(() => {
          send(ws, {
            type: "session:attached",
            name: msg.name,
            ...(msg.attachId ? { attachId: msg.attachId } : {}),
          });
          if (captured) {
            send(ws, { type: "terminal:output", data: captured });
          }
        });

        break;
      }

      case "session:detach": {
        if (conn.pty) {
          conn.pty.markDetaching();
          try {
            conn.pty.kill();
          } catch {
            /* ignore */
          }
          conn.pty = null;
        }
        // Cleared unconditionally: a detach with no live PTY (a failed attach,
        // an exited session) must still leave this connection unattached.
        conn.attachedSession = null;
        conn.lastSize = null;
        if (conn.cloneSession) {
          await destroyClone(conn.cloneSession);
          conn.cloneSession = null;
        }
        break;
      }

      case "session:kill": {
        await tmux.killSession(msg.name);
        send(ws, { type: "session:killed", name: msg.name });
        broadcastWhere(
          (other) =>
            canSee(other, msg.name)
              ? { type: "session:killed", name: msg.name }
              : null,
          ws,
        );
        break;
      }

      case "session:rename": {
        const renameExists = await tmux.sessionExists(msg.oldName);
        if (!renameExists) {
          sendError(
            ws,
            "SESSION_NOT_FOUND",
            `Session "${msg.oldName}" not found`,
          );
          break;
        }
        await tmux.renameSession(msg.oldName, msg.newName);
        send(ws, {
          type: "session:list",
          sessions: await sessionsVisibleTo(conn),
        });
        // Each connection is told its *own* list. A single shared list here
        // was one of the four leaks: it handed every session name on the
        // machine to every connected browser on any rename.
        const listsByGrant = new Map<string, SessionInfo[]>();
        const everything = (await tmux.listSessions()).filter(
          (s) => !isCloneSession(s.name),
        );
        broadcastWhere((other) => {
          const key = other.grant.id;
          let visible = listsByGrant.get(key);
          if (!visible) {
            visible = isFullGrant(other.grant)
              ? everything
              : everything.filter((s) => allowsSession(other.grant, s));
            listsByGrant.set(key, visible);
          }
          return { type: "session:list", sessions: visible };
        }, ws);
        break;
      }

      case "session:windows": {
        const windows = await tmux.listWindows(msg.name);
        const panes = await tmux.listPanes(msg.name);
        send(ws, { type: "session:windows", name: msg.name, windows, panes });
        break;
      }

      case "terminal:input": {
        if (!conn.pty) {
          sendError(ws, "NOT_ATTACHED", "No session attached");
          break;
        }
        conn.pty.write(msg.data);
        break;
      }

      case "terminal:resize": {
        if (!conn.pty) {
          sendError(ws, "NOT_ATTACHED", "No session attached");
          break;
        }
        // Drop no-op resizes. Each pty.resize() is a SIGWINCH, and with
        // `window-size latest` + `aggressive-resize on` tmux redraws for every
        // attached client — including unrelated SSH sessions.
        if (
          conn.lastSize &&
          conn.lastSize.cols === msg.size.cols &&
          conn.lastSize.rows === msg.size.rows
        ) {
          break;
        }
        conn.lastSize = msg.size;
        conn.pty.resize(msg.size);
        break;
      }

      case "command:send": {
        if (!conn.pty) {
          sendError(ws, "NOT_ATTACHED", "No session attached");
          break;
        }
        conn.pty.write(msg.command + "\r");
        break;
      }

      case "command:interrupt": {
        if (conn.attachedSession) {
          await tmux.sendInterrupt(conn.attachedSession);
        }
        break;
      }

      case "command:eof": {
        if (conn.pty) {
          conn.pty.write("\x04"); // Ctrl+D
        }
        break;
      }

      case "command:clear": {
        if (conn.pty) {
          conn.pty.write("\x1b[2J\x1b[H"); // Clear screen
        }
        break;
      }

      case "command:suspend": {
        if (conn.pty) {
          conn.pty.write("\x1a"); // Ctrl+Z
        }
        break;
      }

      case "file:list": {
        if (!files.isPathAllowed(msg.path)) {
          sendError(ws, "ACCESS_DENIED", "Path outside allowed directories");
          break;
        }
        const entries = await files.listDirectory(msg.path);
        send(ws, { type: "file:list", path: msg.path, entries });
        break;
      }

      case "file:read": {
        if (!files.isPathAllowed(msg.path)) {
          sendError(ws, "ACCESS_DENIED", "Path outside allowed directories");
          break;
        }
        const { content, truncated } = await files.readFile(msg.path);
        send(ws, { type: "file:content", path: msg.path, content, truncated });
        break;
      }

      case "file:stat": {
        if (!files.isPathAllowed(msg.path)) {
          sendError(ws, "ACCESS_DENIED", "Path outside allowed directories");
          break;
        }
        const stat = await files.getStats(msg.path);
        send(ws, { type: "file:stat", stat });
        break;
      }

      case "file:watch": {
        if (!files.isPathAllowed(msg.path)) {
          sendError(ws, "ACCESS_DENIED", "Path outside allowed directories");
          break;
        }
        if (conn.watchers.has(msg.path)) break;

        try {
          const watcher = files.watchDirectory(msg.path, (event, filePath) => {
            send(ws, { type: "file:changed", path: filePath, event });
          });
          conn.watchers.set(msg.path, watcher);
        } catch (e) {
          sendError(
            ws,
            "WATCH_FAILED",
            e instanceof Error ? e.message : "Failed to watch path",
          );
        }
        break;
      }

      case "file:unwatch": {
        const watcher = conn.watchers.get(msg.path);
        if (watcher) {
          watcher.close();
          conn.watchers.delete(msg.path);
        }
        break;
      }

      case "file:write": {
        if (!files.isPathAllowed(msg.path)) {
          sendError(ws, "ACCESS_DENIED", "Path outside allowed directories");
          break;
        }
        try {
          const { size } = await files.writeFile(msg.path, msg.content);
          send(ws, {
            type: "file:write:result",
            path: msg.path,
            success: true,
            size,
          });
        } catch (e) {
          send(ws, {
            type: "file:write:result",
            path: msg.path,
            success: false,
            error: e instanceof Error ? e.message : "Write failed",
          });
        }
        break;
      }

      case "file:create": {
        if (!files.isPathAllowed(msg.path)) {
          sendError(ws, "ACCESS_DENIED", "Path outside allowed directories");
          break;
        }
        try {
          await files.createFile(msg.path, msg.content);
          send(ws, {
            type: "file:op:result",
            op: "create",
            path: msg.path,
            success: true,
          });
        } catch (e) {
          send(ws, {
            type: "file:op:result",
            op: "create",
            path: msg.path,
            success: false,
            error: e instanceof Error ? e.message : "Create failed",
          });
        }
        break;
      }

      case "file:mkdir": {
        if (!files.isPathAllowed(msg.path)) {
          sendError(ws, "ACCESS_DENIED", "Path outside allowed directories");
          break;
        }
        try {
          await files.mkdir(msg.path);
          send(ws, {
            type: "file:op:result",
            op: "mkdir",
            path: msg.path,
            success: true,
          });
        } catch (e) {
          send(ws, {
            type: "file:op:result",
            op: "mkdir",
            path: msg.path,
            success: false,
            error: e instanceof Error ? e.message : "Mkdir failed",
          });
        }
        break;
      }

      case "file:delete": {
        if (!files.isPathAllowed(msg.path)) {
          sendError(ws, "ACCESS_DENIED", "Path outside allowed directories");
          break;
        }
        try {
          await files.deleteFile(msg.path);
          send(ws, {
            type: "file:op:result",
            op: "delete",
            path: msg.path,
            success: true,
          });
        } catch (e) {
          send(ws, {
            type: "file:op:result",
            op: "delete",
            path: msg.path,
            success: false,
            error: e instanceof Error ? e.message : "Delete failed",
          });
        }
        break;
      }

      case "file:rename": {
        if (
          !files.isPathAllowed(msg.oldPath) ||
          !files.isPathAllowed(msg.newPath)
        ) {
          sendError(ws, "ACCESS_DENIED", "Path outside allowed directories");
          break;
        }
        try {
          await files.renameFile(msg.oldPath, msg.newPath);
          send(ws, {
            type: "file:op:result",
            op: "rename",
            path: msg.newPath,
            success: true,
          });
        } catch (e) {
          send(ws, {
            type: "file:op:result",
            op: "rename",
            path: msg.newPath,
            success: false,
            error: e instanceof Error ? e.message : "Rename failed",
          });
        }
        break;
      }

      case "file:upload": {
        if (!files.isPathAllowed(msg.path)) {
          sendError(ws, "ACCESS_DENIED", "Path outside allowed directories");
          break;
        }
        try {
          await files.handleUpload(
            conn.uploads,
            msg.path,
            msg.content,
            msg.final,
          );
          if (msg.final) {
            send(ws, {
              type: "file:op:result",
              op: "upload",
              path: msg.path,
              success: true,
            });
          }
        } catch (e) {
          send(ws, {
            type: "file:op:result",
            op: "upload",
            path: msg.path,
            success: false,
            error: e instanceof Error ? e.message : "Upload failed",
          });
        }
        break;
      }

      case "pane:list": {
        if (!conn.attachedSession) {
          sendError(ws, "NOT_ATTACHED", "No session attached");
          break;
        }
        const { panes, windowId } = await currentWindowPanes(
          conn.attachedSession,
        );
        send(ws, { type: "pane:list", panes, windowId });
        break;
      }

      case "pane:split": {
        if (!conn.attachedSession) {
          sendError(ws, "NOT_ATTACHED", "No session attached");
          break;
        }
        await tmux.splitPane(conn.attachedSession, msg.direction);
        await announceLayout(conn, conn.attachedSession);
        break;
      }

      case "pane:select": {
        if (!conn.attachedSession) {
          sendError(ws, "NOT_ATTACHED", "No session attached");
          break;
        }
        await tmux.selectPane(msg.id);
        // Selecting a pane can move the *window* too (`select-pane -t %id`
        // follows the pane into its own window), so the window list has to be
        // republished alongside the pane list.
        const selected = await announceLayout(conn, conn.attachedSession);
        conn.activeWindowId = selected.windowId;
        break;
      }

      case "pane:zoom": {
        if (!conn.attachedSession) {
          sendError(ws, "NOT_ATTACHED", "No session attached");
          break;
        }
        await tmux.zoomPane(conn.attachedSession, {
          ...(msg.id ? { paneId: msg.id } : {}),
          ...(msg.zoomed === undefined ? {} : { desired: msg.zoomed }),
        });
        await announceLayout(conn, conn.attachedSession);
        break;
      }

      case "pane:resize": {
        if (!conn.attachedSession) {
          sendError(ws, "NOT_ATTACHED", "No session attached");
          break;
        }
        await tmux.resizePane(msg.id, msg.direction, msg.amount);
        await announceLayout(conn, conn.attachedSession);
        break;
      }

      case "pane:kill": {
        if (!conn.attachedSession) {
          sendError(ws, "NOT_ATTACHED", "No session attached");
          break;
        }
        await tmux.killPane(msg.id);
        await announceLayout(conn, conn.attachedSession);
        break;
      }

      case "window:step": {
        if (!conn.attachedSession) {
          sendError(ws, "NOT_ATTACHED", "No session attached");
          break;
        }
        // Relative, so it can never target a window that was killed since the
        // client fetched its list.
        await tmux.stepWindow(conn.attachedSession, msg.delta);
        const stepped = await announceLayout(conn, conn.attachedSession);
        conn.activeWindowId = stepped.windowId;
        break;
      }

      case "pane:step": {
        if (!conn.attachedSession) {
          sendError(ws, "NOT_ATTACHED", "No session attached");
          break;
        }
        await tmux.stepPane(conn.attachedSession, msg.delta);
        await announceLayout(conn, conn.attachedSession);
        break;
      }

      case "window:list": {
        if (!conn.attachedSession) {
          sendError(ws, "NOT_ATTACHED", "No session attached");
          break;
        }
        const windows = await tmux.listWindows(conn.attachedSession);
        send(ws, {
          type: "window:list",
          windows,
          sessionName: conn.attachedSession,
        });
        break;
      }

      case "window:create": {
        if (!conn.attachedSession) {
          sendError(ws, "NOT_ATTACHED", "No session attached");
          break;
        }
        await tmux.createWindow(conn.attachedSession, msg.name);
        const created = await announceLayout(conn, conn.attachedSession);
        conn.activeWindowId = created.windowId;
        break;
      }

      case "window:select": {
        if (!conn.attachedSession) {
          sendError(ws, "NOT_ATTACHED", "No session attached");
          break;
        }
        await tmux.selectWindow(msg.id);
        conn.activeWindowId = msg.id;
        await announceLayout(conn, conn.attachedSession);
        break;
      }

      case "window:kill": {
        if (!conn.attachedSession) {
          sendError(ws, "NOT_ATTACHED", "No session attached");
          break;
        }
        const killedId = msg.id;
        await tmux.killWindow(killedId);
        const afterKill = await announceLayout(conn, conn.attachedSession);
        // Reset stale activeWindowId
        if (conn.activeWindowId === killedId) {
          conn.activeWindowId = afterKill.windowId || null;
        }
        break;
      }

      case "pane:swap": {
        if (!conn.attachedSession) {
          sendError(ws, "NOT_ATTACHED", "No session attached");
          break;
        }
        await tmux.swapPane(msg.id, msg.direction);
        await announceLayout(conn, conn.attachedSession);
        break;
      }

      case "window:rename": {
        if (!conn.attachedSession) {
          sendError(ws, "NOT_ATTACHED", "No session attached");
          break;
        }
        await tmux.renameWindow(msg.id, msg.name);
        await announceLayout(conn, conn.attachedSession);
        break;
      }

      case "window:layout": {
        if (!conn.attachedSession) {
          sendError(ws, "NOT_ATTACHED", "No session attached");
          break;
        }
        await tmux.selectLayout(conn.attachedSession, msg.preset);
        await announceLayout(conn, conn.attachedSession);
        break;
      }

      case "layout:rotate": {
        if (!conn.attachedSession) {
          sendError(ws, "NOT_ATTACHED", "No session attached");
          break;
        }
        await tmux.rotateLayout(conn.attachedSession);
        await announceLayout(conn, conn.attachedSession);
        break;
      }

      case "tmux:prefix": {
        if (!conn.attachedSession) {
          sendError(ws, "NOT_ATTACHED", "No session attached");
          break;
        }
        await tmux.sendPrefix(conn.attachedSession);
        break;
      }

      case "tmux:copy-mode": {
        if (!conn.attachedSession) {
          sendError(ws, "NOT_ATTACHED", "No session attached");
          break;
        }
        await tmux.enterCopyMode(conn.attachedSession);
        break;
      }

      case "tmux:scroll": {
        if (!conn.attachedSession) {
          sendError(ws, "NOT_ATTACHED", "No session attached");
          break;
        }
        sendScrollState(
          ws,
          await tmux.scrollHistory(conn.attachedSession, msg.lines),
        );
        break;
      }

      case "tmux:scroll-to": {
        if (!conn.attachedSession) {
          sendError(ws, "NOT_ATTACHED", "No session attached");
          break;
        }
        sendScrollState(
          ws,
          await tmux.scrollToPosition(conn.attachedSession, msg.position),
        );
        break;
      }

      case "tmux:scroll-state": {
        if (!conn.attachedSession) {
          sendError(ws, "NOT_ATTACHED", "No session attached");
          break;
        }
        sendScrollState(ws, await tmux.readScrollState(conn.attachedSession));
        break;
      }

      case "tmux:exit-copy-mode": {
        if (!conn.attachedSession) {
          sendError(ws, "NOT_ATTACHED", "No session attached");
          break;
        }
        await tmux.exitCopyMode(conn.attachedSession);
        // The rail is drawn from this, and leaving copy mode is exactly the
        // moment its thumb belongs back at the bottom.
        sendScrollState(ws, await tmux.readScrollState(conn.attachedSession));
        break;
      }

      case "pane:capture": {
        if (!conn.attachedSession) {
          sendError(ws, "NOT_ATTACHED", "No session attached");
          break;
        }
        const capturedContent = await tmux.capturePaneById(msg.id);
        send(ws, {
          type: "pane:captured",
          id: msg.id,
          content: capturedContent,
        });
        break;
      }

      case "recording:start": {
        try {
          const started = await recorder.start({
            target: msg.target,
            title: msg.title,
          });
          send(ws, { type: "recording:started", recording: started });
        } catch (err) {
          if (err instanceof recorder.RecordingError) {
            sendError(ws, err.code, err.message);
            break;
          }
          throw err;
        }
        break;
      }

      case "recording:stop": {
        if (!(await visibleRecording(conn, msg.id))) {
          sendError(ws, "NOT_FOUND", "Recording not found");
          break;
        }
        const stopped = await recorder.stop(msg.id, "requested");
        if (!stopped) {
          sendError(ws, "NOT_FOUND", "Recording not found");
          break;
        }
        send(ws, {
          type: "recording:stopped",
          recording: stopped,
          reason: stopped.stopReason ?? "requested",
        });
        break;
      }

      case "recording:list": {
        send(ws, {
          type: "recording:list",
          recordings: await visibleRecordings(conn),
        });
        break;
      }

      case "recording:delete": {
        if (!(await visibleRecording(conn, msg.id))) {
          sendError(ws, "NOT_FOUND", "Recording not found");
          break;
        }
        if (recorder.isRecording(msg.id)) {
          await recorder.stop(msg.id, "requested");
        }
        await recordings.remove(msg.id);
        send(ws, { type: "recording:deleted", id: msg.id });
        break;
      }

      case "recording:fetch": {
        // NOT_FOUND, never ACCESS_DENIED. A holder who can tell "exists but
        // denied" from "does not exist" can enumerate every recording id on
        // the machine by probing — the same oracle `policy.ts` refuses to hand
        // out for session names.
        const recording = await visibleRecording(conn, msg.id);
        if (!recording) {
          sendError(ws, "NOT_FOUND", "Recording not found");
          break;
        }
        await streamRecording(ws, recording, msg.offset);
        break;
      }

      case "device:approve": {
        /**
         * A human just answered "is this you?" on their phone.
         *
         * Nothing here decides anything: the decision belongs to the pending
         * request, and this only carries the answer to it. A stale id — the
         * other phone got there first, or the request timed out while the
         * dialog sat on a locked screen — is reported rather than swallowed,
         * because the one thing worse than a slow approval is a person who
         * believes they approved something they did not.
         *
         * The grant check happened in `policy.ts` on the way in. It is not
         * repeated here, and `device-approval.ts` refuses to show the question
         * to a narrow grant in the first place, so answering one it never saw
         * is not reachable even with a forged id.
         */
        if (!resolveDeviceApproval(msg.id, msg.approved)) {
          sendError(
            ws,
            "APPROVAL_NOT_PENDING",
            "That request is no longer waiting for an answer.",
          );
        }
        break;
      }

      case "auth":
        /**
         * A second `auth` on an already-authenticated connection.
         *
         * This used to blanket-acknowledge, and that was the other half of the
         * first finding: the CLI's tunnel agent authenticated the loopback
         * socket with the machine's full `AUTH_TOKEN`, so the browser's own
         * `auth` frame arrived second, on a connection that was already
         * fully privileged, and was rubber-stamped without ever being checked.
         * Over the tunnel there was consequently nothing to scope.
         *
         * The agent no longer injects anything, so the browser's frame is now
         * the *first* message and is authenticated properly by
         * `wireConnections`. Reaching here at all is anomalous — a client
         * re-sending auth on a live connection — and the only safe answer is
         * to say no rather than to hand out a success it did not earn.
         */
        sendError(
          ws,
          "ALREADY_AUTHENTICATED",
          "This connection is already authenticated.",
        );
        break;

      default: {
        const _exhaustive: never = msg;
        sendError(ws, "UNKNOWN_MESSAGE", `Unknown message type`);
      }
    }
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : "Internal error";
    logger.error({ err: e, type: msg.type }, "Message handler error");
    sendError(ws, "HANDLER_ERROR", errMsg);
  }
}
