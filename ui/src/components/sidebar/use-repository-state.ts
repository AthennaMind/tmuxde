import { useCallback, useEffect, useState } from "react";
import type { RepoResult } from "@repo/protocol";
import { useRelayClient } from "@/hooks/use-websocket";
import { usePaneStore } from "@/stores/pane-store";
import { filesDisabled, useConnectionStore } from "@/stores/connection-store";
import { useSessionTreeStore } from "@/stores/session-tree-store";
import {
  repositoryRequest,
  type RepositoryClient,
} from "@/components/files/repository-request";

export type RepositoryContext = Extract<RepoResult, { kind: "context" }>;
export type RepositoryStatus = Extract<RepoResult, { kind: "status" }>;

export interface RepositoryState {
  client: RepositoryClient | null;
  /**
   * Pane the context was asked through. Stays put across a switch to another
   * pane of the same folder. Requests with an absolute path go through the
   * active pane whatever this says, so a pane closed since is harmless.
   */
  paneId: string | null;
  /** Why files cannot be shown, or null when they can. */
  unavailable: string | null;
  context?: RepositoryContext;
  status?: RepositoryStatus;
  loading: boolean;
  error?: string;
  /** Bumped by a manual refresh. Folder listings reload on it. */
  refreshKey: number;
  refresh: () => void;
  /** Reload branch and changes only. Cheap enough to run on a timer. */
  refreshStatus: () => void;
}

const STATUS_INTERVAL_MS = 15_000;

/**
 * Directory, branch and changes of the active pane.
 *
 * Lives at the sidebar root so the rail badge, Files and Changes share one
 * set of requests. `watching` turns on the timer while Files or Changes is
 * on screen.
 */
export function useRepositoryState(watching: boolean): RepositoryState {
  const client = useRelayClient();
  // Folder tmux reports for the active pane, or the pane itself until tmux
  // reports one. The relay announces a `cd` or a focus change within a
  // second, and a new folder asks for a new context. Only the folder is
  // watched: a switch to another pane of the same folder renders nothing and
  // asks nothing. Requests read the active pane when they are sent.
  const folder = usePaneStore((s) => {
    if (!s.activePaneId) return "";
    const path = s.panes.find((p) => p.id === s.activePaneId)?.path;
    return path || `pane:${s.activePaneId}`;
  });
  const connection = useConnectionStore((s) => s.status);
  const capabilities = useConnectionStore((s) => s.capabilities);
  const supported = useConnectionStore((s) => s.features.has("repo:request"));
  // A new socket answers "No session attached" until the relay confirms the
  // attach. Requests wait for it, and run again after every attach: a
  // remount between the phone and desktop layouts detaches and attaches the
  // same session, and a context asked in between was refused for good.
  const attached = useSessionTreeStore((s) => s.attachedSession !== null);
  const attachCount = useSessionTreeStore((s) => s.attachCount);
  const [refreshKey, setRefreshKey] = useState(0);
  const [statusKey, setStatusKey] = useState(0);
  const [pollKey, setPollKey] = useState(0);
  const [context, setContext] = useState<{
    key: string;
    /** Pane the context was asked through. */
    paneId: string;
    value?: RepositoryContext;
    error?: string;
  }>();
  const [status, setStatus] = useState<{
    key: string;
    path: string;
    value?: RepositoryStatus;
    error?: string;
  }>();
  const unavailable = filesDisabled(capabilities)
    ? "File access is disabled for this connection."
    : connection !== "connected" || !client
      ? "Connect to browse files and changes."
      : !supported
        ? "Update tmuxde on this machine to browse files and changes."
        : !folder
          ? "Open a terminal pane to browse its folder."
          : null;
  const available = unavailable === null;
  const ready = available && attached && client && folder;

  const contextKey = ready ? `${folder}:${refreshKey}:${attachCount}` : "";
  useEffect(() => {
    const paneId = usePaneStore.getState().activePaneId;
    if (!contextKey || !client || !paneId) return;
    const controller = new AbortController();
    repositoryRequest(
      client,
      { id: paneId, action: "context" },
      controller.signal,
    )
      .then((result) => {
        if (!controller.signal.aborted && result.kind === "context")
          setContext({ key: contextKey, paneId, value: result });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setContext({
            key: contextKey,
            paneId,
            error:
              error instanceof Error
                ? error.message
                : "Could not find the pane folder.",
          });
      });
    return () => controller.abort();
  }, [client, contextKey]);

  // The last answer stays on screen until the next one lands, also across a
  // pane switch. Blanking the tree on every switch made it flash and reload
  // each open folder. Everything returned describes the context's own pane,
  // so status, listings and opened files never mix two folders.
  const currentContext = available ? context : undefined;
  const contextPath = currentContext?.value?.path;
  const contextPane = currentContext?.paneId;
  const statusBase =
    ready && contextPath
      ? `${contextPath}:${refreshKey}:${statusKey}:`
      : "";
  const statusRequestKey = statusBase ? `${statusBase}${pollKey}` : "";
  useEffect(() => {
    // An absolute path, so `repositoryRequest` sends it through the active pane.
    const paneId = usePaneStore.getState().activePaneId ?? contextPane;
    if (!statusRequestKey || !client || !paneId || !contextPath) return;
    const controller = new AbortController();
    repositoryRequest(
      client,
      { id: paneId, action: "status", path: contextPath },
      controller.signal,
    )
      .then((result) => {
        if (!controller.signal.aborted && result.kind === "status")
          setStatus({
            key: statusRequestKey,
            path: contextPath,
            value: result,
          });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setStatus({
            key: statusRequestKey,
            path: contextPath,
            error:
              error instanceof Error ? error.message : "Could not load changes.",
          });
      });
    return () => controller.abort();
  }, [client, contextPath, statusRequestKey]);

  const currentStatus =
    status && status.path === contextPath ? status : undefined;

  const refresh = useCallback(() => setRefreshKey((n) => n + 1), []);
  const refreshStatus = useCallback(() => setStatusKey((n) => n + 1), []);

  // Timer refreshes skip the spinner. Only a request someone asked for spins.
  useEffect(() => {
    if (!watching || !ready) return;
    const tick = () => {
      if (document.visibilityState === "visible") setPollKey((n) => n + 1);
    };
    const interval = setInterval(tick, STATUS_INTERVAL_MS);
    window.addEventListener("focus", tick);
    return () => {
      clearInterval(interval);
      window.removeEventListener("focus", tick);
    };
  }, [watching, ready]);

  const attaching = available && !attached;
  const contextPending = !!ready && context?.key !== contextKey;
  const statusPending =
    !!statusBase && !(status?.key.startsWith(statusBase) ?? false);

  return {
    client: available ? client : null,
    paneId: contextPane ?? null,
    unavailable,
    context: currentContext?.value,
    status: currentStatus?.value,
    loading: attaching || contextPending || statusPending,
    error: currentContext?.error ?? currentStatus?.error,
    refreshKey,
    refresh,
    refreshStatus,
  };
}
