import { useCallback, useEffect, useRef, useState } from "react";
import type { RepoResult } from "@/protocol";
import { useRelayClient } from "@/features/connection/use-websocket";
import { useVisibleInterval } from "@/shared/use-visible-interval";
import { sameRoot } from "./repo-change";
import { useRepoWatch, useRepoWatchStore, watchHealthy } from "./repo-watch-store";
import { usePaneStore } from "@/features/panes/pane-store";
import { filesDisabled, useConnectionStore } from "@/features/connection/connection-store";
import { useSessionTreeStore } from "@/features/session/session-tree-store";
import { repositoryRequest, type RepositoryClient } from "./repository-request";

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

/** Status poll while no server watch covers the repository. */
const STATUS_INTERVAL_MS = 15_000;
/** Safety poll while the server watch pushes changes. */
const WATCHED_INTERVAL_MS = 120_000;
/** Pushes closer than this share one status request. */
const PUSH_DEBOUNCE_MS = 200;

/**
 * Directory, branch and changes of the active pane.
 *
 * Lives at the sidebar root so the rail badge, Files and Changes share one
 * set of requests. A server watch on the repository pushes changes, and
 * each push asks for status again. The watch stays while the sidebar is
 * collapsed, so the rail badge stays fresh. `watching` turns on the safety
 * poll while Files, Changes or History is on screen.
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
    repositoryRequest(client, { id: paneId, action: "context" }, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted && result.kind === "context")
          setContext({ key: contextKey, paneId, value: result });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setContext({
            key: contextKey,
            paneId,
            error: error instanceof Error ? error.message : "Could not find the pane folder.",
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
  const statusBase = ready && contextPath ? `${contextPath}:${refreshKey}:${statusKey}:` : "";
  const statusRequestKey = statusBase ? `${statusBase}${pollKey}` : "";
  // A status request in flight, and a push that came in meanwhile. Pushes
  // never start a second request. One more runs after the answer instead.
  const statusBusy = useRef(false);
  const statusAgain = useRef(false);
  useEffect(() => {
    // An absolute path, so `repositoryRequest` sends it through the active pane.
    const paneId = usePaneStore.getState().activePaneId ?? contextPane;
    if (!statusRequestKey || !client || !paneId || !contextPath) return;
    const controller = new AbortController();
    statusBusy.current = true;
    const settle = () => {
      statusBusy.current = false;
      if (statusAgain.current) {
        statusAgain.current = false;
        setPollKey((n) => n + 1);
      }
    };
    repositoryRequest(
      client,
      { id: paneId, action: "status", path: contextPath },
      controller.signal,
    )
      .then((result) => {
        if (controller.signal.aborted) return;
        if (result.kind === "status")
          setStatus({
            key: statusRequestKey,
            path: contextPath,
            value: result,
          });
        settle();
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setStatus({
          key: statusRequestKey,
          path: contextPath,
          error: error instanceof Error ? error.message : "Could not load changes.",
        });
        settle();
      });
    return () => {
      controller.abort();
      statusBusy.current = false;
    };
  }, [client, contextPath, statusRequestKey]);

  // The server watch of the repository. Kept while the sidebar is collapsed.
  const root = ready ? currentContext?.value?.root : undefined;
  const watch = useRepoWatch(ready ? client : null, root, {
    paneId: contextPane ?? null,
    path: contextPath,
  });
  const healthy = watchHealthy(watch);

  // Each push for this repository asks for status again, quietly. Git
  // changes come this way too, and History follows the new status.
  useEffect(() => {
    if (!root) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = useRepoWatchStore.subscribe((s, prev) => {
      const change = s.lastChange;
      if (!change || change === prev.lastChange || !sameRoot(change, root)) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (statusBusy.current) statusAgain.current = true;
        else setPollKey((n) => n + 1);
      }, PUSH_DEBOUNCE_MS);
    });
    return () => {
      clearTimeout(timer);
      unsubscribe();
    };
  }, [root]);

  const currentStatus = status && status.path === contextPath ? status : undefined;

  const refresh = useCallback(() => setRefreshKey((n) => n + 1), []);
  const refreshStatus = useCallback(() => setStatusKey((n) => n + 1), []);

  // Timer refreshes skip the spinner. Only a request someone asked for spins.
  // The poll is the safety net under the watch: slow while the watch covers
  // the whole work tree, the old pace without it. Focus and a tab coming back
  // to view ask at once.
  useVisibleInterval(
    () => {
      if (!statusBusy.current) setPollKey((n) => n + 1);
    },
    healthy ? WATCHED_INTERVAL_MS : STATUS_INTERVAL_MS,
    { enabled: watching && !!ready, debounceMs: 1_000 },
  );

  const attaching = available && !attached;
  const contextPending = !!ready && context?.key !== contextKey;
  const statusPending = !!statusBase && !(status?.key.startsWith(statusBase) ?? false);

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
