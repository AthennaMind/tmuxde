"use client";

import { useEffect, useRef, useCallback } from "react";
import type { DependencyList } from "react";
import type { ClientMessage, ServerMessage } from "@repo/protocol";
import { RelayClient } from "@/lib/ws-client";
import { directTransport, type TransportFactory } from "@/lib/transport";
import { reresolveActiveRoute } from "@/lib/resolve-route";
import { resolveRelayWsUrl } from "@/lib/relay-url";
import { useConnectionStore } from "@/stores/connection-store";
import { useSessionStore } from "@/stores/session-store";
import { usePaneStore } from "@/stores/pane-store";
import { useFileStore } from "@/stores/file-store";
import { useAlertStore } from "@/stores/alert-store";
import { useRecordingStore } from "@/stores/recording-store";
import { useDeviceApprovalStore } from "@/stores/device-approval-store";
import { useUiStore } from "@/stores/ui-store";
import { useScrollStore } from "@/stores/scroll-store";
import {
  awaitingScrollStateProbe,
  noteScrollStateReply,
} from "@/lib/terminal-scroll";
import { TOKEN_KEY, clearStored } from "@/lib/storage-keys";
import * as registry from "@/lib/relay-registry";
import { markBounced } from "@/lib/bounce-guard";
import {
  clearDescriptorMirror,
  clearSessionKeys,
  loadDescriptor,
  serverIdFor,
} from "@/lib/session-store";
import { isMobileViewport } from "@/lib/mobile-query";

// #1: Dedup session exit toasts — track handled exits at module scope
const handledExits = new Set<string>();

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
 * Reconnect, re-deciding the route first.
 *
 * The same recovery the client runs on its own after a failure streak, exposed
 * so the connection banner's "Try another route" can trigger it on demand
 * rather than making someone wait out a thirty-second backoff for a route that
 * is not going to start working.
 *
 * Falls back to a plain reconnect when there is nothing to re-resolve, which is
 * the self-hosted path.
 */
export async function reconnectWithFreshRoute(): Promise<void> {
  const client = getRelayClient();
  if (!client) return;
  const route = await reresolveActiveRoute().catch(() => null);
  if (!route) {
    client.connect();
    return;
  }
  client.setTransport(route.transport ?? directTransport(resolveRelayWsUrl()));
}

/**
 * Which machine this tab's socket belongs to.
 *
 * A hosted pairing keys on the paired machine's device id; the self-hosted and
 * split deployments have no such id and share `LOCAL_SERVER_ID`, which is
 * correct — there is exactly one relay in those topologies.
 */
function currentServerId(): string {
  const session = loadDescriptor();
  return session ? serverIdFor(session.descriptor) : registry.LOCAL_SERVER_ID;
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

/**
 * @param transport Optional socket seam. Omitted for the direct and
 * self-hosted paths, which use a plain WebSocket at `url`; supplied by the
 * terminal layout when a paired session fell back to the sealed tunnel.
 */
export function useWebSocket(
  url: string,
  token: string,
  transport?: TransportFactory,
) {
  const clientRef = useRef<RelayClient | null>(null);

  useEffect(() => {
    if (!url || !token) return;

    const serverId = currentServerId();
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
          /*
           * A refusal is not a dead credential, and telling the two apart is
           * the whole of this branch.
           *
           * Every connection is now put to a human at the machine — see
           * `connection-gate.ts` — so "no" and "nobody answered" are ordinary
           * outcomes on a pairing that is in perfect health. Wiping the token
           * and the session keys for one of those would destroy a working
           * pairing because somebody was slow to reach their laptop, and the
           * only way back would be to pair again. So this leaves everything
           * on disk exactly as it is and says what happened.
           */
          if (msg.code === "unapproved") {
            useAlertStore
              .getState()
              .push(
                "error",
                "Not approved on the machine. Say yes there, then reconnect.",
              );
            connectionStore.setStatus("disconnected");
            break;
          }
          /*
           * The toast used to be the only explanation, and it never arrived.
           *
           * `window.location.href` is a full document navigation, so the alert
           * store — plain in-memory Zustand — is destroyed before anything can
           * render it. `markBounced` is what `/start` actually reads to say
           * "that session is no longer usable", and nothing on this path was
           * calling it: the user landed on a bare code-entry form with no clue
           * why they had been thrown out of a terminal that was working a
           * moment ago.
           */
          markBounced();
          clearStored(TOKEN_KEY);
          // The stored pairing is dead — the CLI has forgotten this device, or
          // its record expired — so leaving the keys behind only guarantees the
          // same bounce on the next load.
          void clearSessionKeys(currentServerId()).catch(() => {});
          clearDescriptorMirror();
          // `/start`, not `/login`: the credential that just failed may have
          // been a derived pairing token, in which case a form asking for a
          // 64-hex relay token is not a way back in.
          window.location.href = "/start";
          break;
        case "server:info":
          connectionStore.setServerInfo("", msg.hostname);
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
          sessionStore.setSessions(msg.sessions);
          break;
        case "session:created":
          sessionStore.addSession(msg.session);
          break;
        case "session:killed":
          sessionStore.removeSession(msg.name);
          break;
        case "session:activity":
          sessionStore.updateSessionActivity(msg.name, msg.activity);
          break;
        case "session:exited":
          // #1: Deduplicate exit toasts — skip if already handled
          if (!handledExits.has(msg.name)) {
            handledExits.add(msg.name);
            sessionStore.removeSession(msg.name);
            // Clear pane/zoom state if this was the active session
            if (sessionStore.activeSessionId === null) {
              usePaneStore.getState().clearAll();
            }
            useAlertStore
              .getState()
              .push("info", `Session "${msg.name}" exited`);
            setTimeout(() => handledExits.delete(msg.name), 10000);
          }
          break;
        case "pane:list":
        case "pane:changed": {
          const paneStore = usePaneStore.getState();
          paneStore.setPanes(msg.panes, msg.windowId);
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
        case "file:write:result":
          // Handled in file-editor component via onMessage subscription
          break;
        case "file:op:result": {
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
          // Handled in terminal-view
          break;
        case "tmux:scroll-state":
          noteScrollStateReply();
          useScrollStore.getState().setScrollState({
            position: msg.position,
            historySize: msg.historySize,
            paneHeight: msg.paneHeight,
            inMode: msg.inMode,
          });
          break;
        case "pane:captured":
          useUiStore.getState().setCapturedPane(msg.id, msg.content);
          break;
        case "session:windows":
          // Handled by SessionCard via direct onMessage subscription
          break;

        case "recording:list":
          useRecordingStore.getState().setRecordings(msg.recordings);
          break;
        case "recording:started":
          useRecordingStore.getState().upsert(msg.recording);
          break;
        case "recording:stopped":
          useRecordingStore.getState().upsert(msg.recording);
          if (msg.reason === "limit") {
            // A recording that silently stopped growing reads as a bug. One
            // that says why reads as a limit, which is what it is.
            useAlertStore
              .getState()
              .push(
                "warning",
                `Recording "${msg.recording.title}" reached its size or time limit and closed.`,
              );
          }
          break;
        case "recording:deleted":
          useRecordingStore.getState().remove(msg.id);
          break;
        case "recording:chunk":
          // Delivered to whoever is fetching, through a direct `onMessage`
          // subscription. Reassembly is `lib/cast-fetch.ts`, and routing 64 KiB
          // of base64 through a Zustand store would re-render every subscriber
          // once per chunk.
          break;
        case "device:approval-request":
          /*
           * The one message that asks rather than tells.
           *
           * Straight into its own store and onto the screen as a modal — not
           * an alert. See `device-approval-dialog.tsx` for why a banner would
           * be a security hole rather than a styling choice: a question that
           * fades after six seconds is a question the user was never asked,
           * and the request would expire while they were reading the terminal.
           */
          useDeviceApprovalStore.getState().open(msg);
          break;
        case "device:approval-resolved": {
          /*
           * Somebody answered — possibly this browser, possibly the phone in
           * the other room, possibly nobody before it expired. Close the
           * dialog either way, then say what happened.
           *
           * Told rather than inferred, because the second phone showing the
           * same dialog has no way to know. Leaving it up would offer a
           * decision that can no longer be made.
           */
          const store = useDeviceApprovalStore.getState();
          const byThisDevice = store.answering && store.request?.id === msg.id;
          if (store.request && store.request.id !== msg.id) break;
          store.close();
          if (msg.reason === "expired") {
            useAlertStore
              .getState()
              .push("warning", "A device request expired unanswered. Denied.");
          } else if (msg.reason === "withdrawn") {
            // Somebody answered at the machine, or in `mtmux approve`. A
            // dialog that simply vanished would read as a bug on the one
            // screen where the user most needs to know what happened.
            useAlertStore
              .getState()
              .push("info", "That device request was answered on the machine.");
          } else if (msg.reason === "decided") {
            useAlertStore
              .getState()
              .push(
                msg.approved ? "success" : "info",
                msg.approved
                  ? byThisDevice
                    ? "Approved. The device is being let in."
                    : "A device was approved somewhere else."
                  : byThisDevice
                    ? "Denied. Nothing was granted."
                    : "A device request was denied somewhere else.",
              );
          }
          break;
        }
        case "device:paired": {
          /*
           * A security signal, surfaced rather than swallowed.
           *
           * Pairing is otherwise only visible on the machine's own screen, so
           * a browser already holding a session had no way to learn that a
           * second device had been let in — which is precisely the event worth
           * knowing about, and precisely the one an attacker would want quiet.
           *
           * `warning` rather than `success`: from *this* browser's point of
           * view someone else getting access is news to check, not news to
           * celebrate. The device that just paired sees it too, where it reads
           * as a confirmation.
           */
          useAlertStore
            .getState()
            .push(
              "warning",
              msg.via === "request"
                ? `${msg.label} was approved on this machine.`
                : `${msg.label} paired with this machine.`,
            );
          break;
        }
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
          transport,
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
            if (status === "reconnecting") {
              useConnectionStore.getState().incrementReconnect();
            }
            // A question we can no longer answer must come off the screen.
            //
            // The socket is how the answer travels, so an approval dialog left
            // up over a dead connection is a button that does nothing. Worse,
            // the relay has already given the question back to the machine's
            // own prompts by this point — so the dialog would be offering a
            // decision that has moved elsewhere. Abandoning records no
            // outcome, because none was reached here.
            if (status === "disconnected" || status === "reconnecting") {
              useDeviceApprovalStore.getState().abandon();
            }
          },
          /**
           * The address stopped answering, so stop assuming it is the address.
           *
           * A session that won a direct LAN candidate keeps using it across
           * network changes, and a phone that leaves the house then retries an
           * unreachable `192.168.x.y` forever. Re-racing here is what lets it
           * fall through to the tunnel without the user doing anything.
           *
           * A no-op on the self-hosted path: there is no descriptor to
           * re-resolve, so this returns null and the existing retry loop
           * carries on untouched.
           */
          onRouteStale: () => {
            void (async () => {
              const route = await reresolveActiveRoute().catch(() => null);
              if (!route) return;
              const active = clientRef.current;
              if (!active) return;
              active.setTransport(
                route.transport ?? directTransport(resolveRelayWsUrl()),
              );
            })();
          },
        }),
      `${url}|${token}|${transport ? "sealed" : "direct"}`,
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
  }, [url, token, transport]);

  const send = useCallback((msg: ClientMessage) => {
    clientRef.current?.send(msg);
  }, []);

  return { send, client: clientRef.current };
}
