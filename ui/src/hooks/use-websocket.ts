import { receiveTerminalPreview } from "@/stores/terminal-preview-store";
import { useEffect, useRef, useCallback } from "react";
import type { DependencyList } from "react";
import type { ClientMessage, ServerMessage } from "@/protocol";
import { useMachineStore } from "@/stores/machine-store";
import { copyFailureReason, copyText } from "@/lib/clipboard";
import { machineId } from "@/lib/machine-context";
import { RelayClient } from "@/lib/ws-client";
import { useConnectionStore } from "@/stores/connection-store";
import { useSessionStore } from "@/stores/session-store";
import { usePaneStore } from "@/stores/pane-store";
import { useFileStore } from "@/stores/file-store";
import { useAlertStore } from "@/stores/alert-store";
import { useUiStore } from "@/stores/ui-store";
import { useScrollStore } from "@/stores/scroll-store";
import {
  awaitingScrollStateProbe,
  noteScrollStateReply,
  requestScrollState,
} from "@/lib/terminal-scroll";
import { TOKEN_KEY, clearStored } from "@/lib/storage-keys";
import * as registry from "@/lib/relay-registry";
import { isMobileViewport } from "@/lib/mobile-query";
import { noteSessionAttached, noteSessionDetached } from "@/lib/session-target";
import { useSessionTreeStore } from "@/stores/session-tree-store";
import { useRepoWatchStore } from "@/stores/repo-watch-store";
import { handleDictationMessage } from "@/lib/dictation";
import {
  applySessionList,
  forgetMissingSession,
  forgetSession,
  isAttachFallout,
  isRenamedAway,
  noteSessionCreated,
  sessionNotFoundText,
} from "@/lib/session-lifecycle";
import { receiveTerminalSearch } from "@/stores/terminal-search-store";

/**
 * Sessions whose end was already reported, for ten seconds.
 *
 * One end can arrive twice: the pty exit and the monitor both say
 * `session:exited`, and a kill also says `session:killed`. A kill is its own
 * explanation, so the exit that follows it stays quiet.
 */
const handledExits = new Set<string>();
const HANDLED_EXIT_MS = 10_000;

function markHandledExit(name: string): void {
  handledExits.add(name);
  setTimeout(() => handledExits.delete(name), HANDLED_EXIT_MS);
}

/**
 * The client for the machine the terminal is currently driving.
 *
 * Kept as a shim over the registry on purpose. There are twenty-odd call sites
 * across the terminal, every one of which means "the connection I am looking
 * at"; threading a server id through all of them would be churn with no
 * behaviour change, and the terminal genuinely only ever drives one machine at
 * a time. The dashboard, which is the only thing that needs several at once,
 * asks the registry directly.
 */
export function getRelayClient(): RelayClient | null {
  return registry.getActive();
}

/**
 * Subscribe to relay messages, re-attaching whenever the connection status
 * changes. This binds once the client exists (it's created asynchronously by
 * the layout's `useWebSocket` effect, so it's null on first child mount) and
 * re-binds on a new socket after a reconnect. The latest `handler` is kept in a
 * ref so the subscription stays stable and doesn't churn on every render.
 */
export function useRelaySubscription(
  handler: (msg: ServerMessage) => void,
  deps: DependencyList = [],
): void {
  const status = useConnectionStore((s) => s.status);
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    const client = getRelayClient();
    if (!client) return;
    return client.onMessage((msg) => ref.current(msg));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, ...deps]);
}

/**
 * Return the current relay client and subscribe the caller to the connection
 * status so the component re-renders (and its client-dependent effects re-run)
 * once the client attaches or reconnects. Use this for "send an initial request
 * when connected" needs, e.g. the file tree's directory load.
 */
export function useRelayClient(): RelayClient | null {
  useConnectionStore((s) => s.status); // re-render when the client attaches / reconnects
  return getRelayClient();
}

/** Opens the socket to the server at `url` and applies its messages to the stores. */
export function useWebSocket(url: string, token: string) {
  const clientRef = useRef<RelayClient | null>(null);

  useEffect(() => {
    if (!url || !token) return;

    const serverId = machineId();
    handledExits.clear();
    // Assigned by `acquire` below; the handler is only ever invoked by a
    // connected client, so it is never null by the time it is read.
    let client: RelayClient | null = null;

    const handleMessage = (msg: ServerMessage) => {
      const sessionStore = useSessionStore.getState();
      const connectionStore = useConnectionStore.getState();

      switch (msg.type) {
        case "auth:success":
          connectionStore.setServerInfo(msg.serverVersion, "");
          // A relay too old to send this leaves the field undefined, which is
          // exactly what an unrestricted connection looks like — so ?? null
          // rather than a separate "unknown" state.
          connectionStore.setCapabilities(msg.capabilities ?? null);
          // Same reasoning, opposite default: an unknown message type is a
          // hard `INVALID_MESSAGE` on an older relay, so absence has to read
          // as "supports none of them" and the caller falls back.
          connectionStore.setFeatures(msg.features);
          connectionStore.resetReconnect();
          // Auto-request session list on connect
          client?.send({ type: "session:list" });
          // Don't send session:attach here. TerminalView re-attaches from its
          // status-dependent effect, which guarantees exactly one attach per
          // connection — a second one would kill and respawn the PTY.
          break;
        case "auth:failure":
          // The token is no longer valid. Drop it and go to the login page.
          // A full navigation, so every store starts empty there.
          clearStored(TOKEN_KEY);
          window.location.href = "/login";
          break;
        case "server:info":
          connectionStore.setServerInfo("", msg.hostname, msg.defaultPath);
          // Open the file browser to the relay's primary allowed directory so
          // it lists successfully out of the box (the hardcoded "/home" default
          // is outside the allow-list when the CLI scopes it to $HOME).
          if (msg.defaultPath) {
            useFileStore.getState().applyServerDefaultPath(msg.defaultPath);
          }
          break;
        case "pong":
          connectionStore.setLatency(Date.now() - msg.timestamp);
          break;
        case "session:list":
          // Follows a rename by session id, wherever it was made.
          applySessionList(msg.sessions);
          break;
        case "session:created":
          noteSessionCreated(msg.session);
          break;
        case "session:killed":
          if (!handledExits.has(msg.name)) markHandledExit(msg.name);
          forgetSession(msg.name);
          break;
        case "session:activity":
          sessionStore.updateSessionActivity(msg.name, msg.activity);
          break;
        case "session:exited":
          // The old name of a session this tab followed to a new name.
          if (isRenamedAway(msg.name)) break;
          // Forgotten every time, told once. A name can come back, and the
          // newer session's end must not be mistaken for a repeat.
          forgetSession(msg.name);
          if (!handledExits.has(msg.name)) {
            markHandledExit(msg.name);
            useAlertStore
              .getState()
              .push("info", `Session "${msg.name}" exited`);
          }
          break;
        case "pane:list":
        case "pane:changed": {
          const paneStore = usePaneStore.getState();
          const previousPane = paneStore.activePaneId;
          paneStore.setPanes(msg.panes, msg.windowId);
          // Copy mode is a fact about a pane, and the client's belief about it
          // is kept per session. A pane left scrolled back stays in copy mode,
          // so a switch to another pane has to ask again, or the old pane's
          // state follows the user to the new one and blocks paste there.
          if (usePaneStore.getState().activePaneId !== previousPane) {
            requestScrollState();
          }
          // Auto-zoom: if pending and no pane is currently zoomed, zoom the active pane
          if (paneStore.pendingAutoZoom) {
            const zoomedPane = msg.panes.find((p) => p.zoomed);
            if (!zoomedPane && isMobileViewport()) {
              // Name the pane and the state. A bare `pane:zoom` is a toggle,
              // and this fires off an announcement that may race a tap the
              // user has already made — see `lib/pane-zoom.ts`.
              const active = msg.panes.find((p) => p.active);
              client?.send({
                type: "pane:zoom",
                ...(active ? { id: active.id } : {}),
                zoomed: true,
              });
            }
            paneStore.setPendingAutoZoom(false);
          }
          break;
        }
        case "window:list":
        case "window:changed": {
          const paneStore = usePaneStore.getState();
          paneStore.setWindows(msg.windows);
          break;
        }
        case "repo:result":
          // Repository browser correlates replies to its active request.
          break;
        case "repo:watch:result":
          // A refusal is quiet. The views keep polling without the watch.
          useRepoWatchStore.getState().applyResult(msg);
          break;
        case "repo:changed":
          useRepoWatchStore.getState().applyChange(msg);
          break;
        case "file:write:result":
          // Handled in file-editor component via onMessage subscription
          break;
        case "file:op:result": {
          if (msg.op === "upload" && msg.final === false) break;
          useFileStore.getState().setIsOperating(false);
          if (msg.success) {
            useAlertStore
              .getState()
              .push(
                "success",
                `${msg.op} succeeded: ${msg.path.split("/").pop()}`,
              );
            // Refresh current directory listing
            const { currentPath: dirPath } = useFileStore.getState();
            client?.send({ type: "file:list", path: dirPath });
          } else {
            useAlertStore
              .getState()
              .push("error", msg.error ?? `${msg.op} failed`);
          }
          break;
        }
        case "session:attached":
          // Terminal view handles the stream. The session tree sends any
          // window or pane selection that waited on this attach.
          noteSessionAttached(msg.name);
          const action = useMachineStore.getState().pendingAction;
          if (action?.machineId === serverId && action.sessionName === msg.name) {
            useMachineStore.setState({ pendingAction: null });
            if (action.expires > Date.now()) {
              for (const message of action.messages) client?.send(message);
            }
          }
          // The scroll rail asks shortly after the session changes, but on a
          // page load that is before the socket is connected and the ask is
          // dropped. This is the moment the relay can answer, and the answer
          // is also what stops scrolling from guessing about copy mode.
          requestScrollState();
          break;
        case "tmux:scroll-state":
          noteScrollStateReply(msg.inMode);
          useScrollStore.getState().setScrollState({
            position: msg.position,
            historySize: msg.historySize,
            paneHeight: msg.paneHeight,
            inMode: msg.inMode,
          });
          break;
        case "terminal:preview:frame":
          receiveTerminalPreview(serverId, msg);
          break;
        case "terminal:search:result":
          receiveTerminalSearch(serverId, msg);
          break;
        case "pane:captured": {
          const capture = useMachineStore.getState().capture;
          if (capture?.machineId === serverId && capture.paneId === msg.id &&
            capture.expires > Date.now()) {
            useMachineStore.setState({ capture: null });
            void copyText(msg.content).then((ok) => {
              useAlertStore.getState().push(
                ok ? "success" : "error",
                ok ? "Copied pane contents" : copyFailureReason(),
              );
            });
          } else {
            useUiStore.getState().setCapturedPane(msg.id, msg.content);
          }
          break;
        }
        case "session:windows":
          // Mobile SessionCard also listens directly for its own request.
          useSessionTreeStore.getState().setDetails(msg.name, {
            windows: msg.windows,
            panes: msg.panes,
          });
          break;
        case "dictation:ready":
        case "dictation:text":
        case "dictation:done":
        case "dictation:error":
          handleDictationMessage(msg);
          break;
        case "error":
          /*
           * One error is ours, and is not news.
           *
           * A relay older than `tmux:scroll-state` rejects it as
           * `INVALID_MESSAGE`, and the probe that asked is how the client
           * finds out the machine cannot answer — see `lib/terminal-scroll.ts`.
           * Showing that to the user would be an error toast on every attach
           * to a machine whose CLI is a version behind, about a question they
           * never asked. Only a probe in flight qualifies, so a genuinely
           * malformed message still surfaces.
           */
          if (msg.code === "INVALID_MESSAGE" && awaitingScrollStateProbe()) {
            break;
          }
          /*
           * The active session is gone. A reload or a stale list asked for a
           * session that was killed or renamed meanwhile. Drop it, so the
           * terminal shows the next session or the empty state instead of
           * waiting on an attach that cannot land. The requests sent along
           * with the attach then answer `NOT_ATTACHED`, which is no news.
           */
          if (isAttachFallout(msg.code)) break;
          // The editor watches the folder of its file to notice outside
          // changes. Without the watch it still opens and saves, so a
          // failed watch is no news either.
          if (msg.code === "WATCH_FAILED") break;
          if (
            msg.code === "SESSION_NOT_FOUND" &&
            sessionStore.activeSessionId !== null &&
            msg.message === sessionNotFoundText(sessionStore.activeSessionId)
          ) {
            forgetMissingSession(sessionStore.activeSessionId);
          }
          useAlertStore.getState().push("error", msg.message);
          break;
      }
    };

    client = registry.acquire(
      serverId,
      () =>
        new RelayClient({
          url,
          token,
          onMessage: handleMessage,
          onMessageDropped: (count) => {
            useAlertStore
              .getState()
              .push(
                "warning",
                `${count} queued request${count === 1 ? "" : "s"} dropped while disconnected`,
              );
          },
          onStatusChange: (status) => {
            useConnectionStore.getState().setStatus(status);
            if (status === "disconnected" || status === "reconnecting") {
              useMachineStore.setState({ pendingAction: null });
            }
            if (status !== "connected") {
              noteSessionDetached();
              // The server drops watches with the socket.
              useRepoWatchStore.getState().reset();
            }
            if (status === "reconnecting") {
              useConnectionStore.getState().incrementReconnect();
            }
          },
        }),
      `${url}|${token}`,
    );
    // The terminal drives one machine at a time, and this is the hook that
    // decided which. Every `getRelayClient()` call site reads back through here.
    registry.setActive(serverId);

    const held = client;
    clientRef.current = held;
    held.connect();

    const handleOnline = () => {
      if (held.status === "disconnected" || held.status === "reconnecting") {
        held.reconnectNow();
      }
    };

    /*
     * Coming back to the tab is the strongest reconnect signal there is, and
     * nothing was listening for it.
     *
     * A phone backgrounded for an hour has its timers suspended and its socket
     * quietly killed by the OS. On resume the backoff ladder has already
     * climbed to its 30s ceiling, so the user watches "Reconnecting — input
     * paused" for up to half a minute on a network that is working fine. The
     * zombie detector cannot help: it is a 10s interval, which is exactly what
     * was suspended. `online` does not fire either — it tracks interface
     * transitions, not wake-ups.
     */
    const handleVisible = () => {
      if (document.visibilityState !== "visible") return;
      if (held.status === "connected" || held.status === "connecting") return;
      held.reconnectNow();
    };

    const handleOffline = () => {
      // Tear the socket down rather than only painting the banner. Writing the
      // store status directly used to desync it from RelayClient — the UI said
      // "Disconnected" while the client still believed it was connected, so
      // nothing ever put it back and anything keyed on the store status stayed
      // stuck. Going through disconnect() keeps the two in step; `online` above
      // reconnects.
      held.disconnect();
    };

    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    document.addEventListener("visibilitychange", handleVisible);

    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
      document.removeEventListener("visibilitychange", handleVisible);
      // The last holder disconnects; an overlapping remount (StrictMode, or a
      // route change that reuses the connection) keeps it alive.
      registry.release(serverId);
    };
  }, [url, token]);

  const send = useCallback((msg: ClientMessage) => {
    clientRef.current?.send(msg);
  }, []);

  return { send, client: clientRef.current };
}
