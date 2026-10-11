"use client";

import { useCallback, useEffect, useState } from "react";
import type { RepoResult } from "@repo/protocol";
import { useRelayClient } from "@/hooks/use-websocket";
import { usePaneStore } from "@/stores/pane-store";
import { filesDisabled, useConnectionStore } from "@/stores/connection-store";
import {
  repositoryRequest,
  type RepositoryClient,
} from "@/components/files/repository-request";

export type RepositoryContext = Extract<RepoResult, { kind: "context" }>;
export type RepositoryStatus = Extract<RepoResult, { kind: "status" }>;

export interface RepositoryState {
  client: RepositoryClient | null;
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
  const paneId = usePaneStore((s) => s.activePaneId);
  const connection = useConnectionStore((s) => s.status);
  const capabilities = useConnectionStore((s) => s.capabilities);
  const supported = useConnectionStore((s) => s.features.has("repo:request"));
  const [refreshKey, setRefreshKey] = useState(0);
  const [statusKey, setStatusKey] = useState(0);
  const [pollKey, setPollKey] = useState(0);
  const [context, setContext] = useState<{
    key: string;
    paneId: string;
    value?: RepositoryContext;
    error?: string;
  }>();
  const [status, setStatus] = useState<{
    key: string;
    paneId: string;
    path: string;
    value?: RepositoryStatus;
    error?: string;
  }>();

  const unavailable = filesDisabled(capabilities)
    ? "File access is disabled for this connection."
    : connection !== "connected" || !client
      ? "Connect to browse files and changes."
      : !supported
        ? "Update mtmux on this machine to browse files and changes."
        : !paneId
          ? "Open a terminal pane to browse its folder."
          : null;
  const ready = unavailable === null && client && paneId;

  const contextKey = ready ? `${paneId}:${refreshKey}` : "";
  useEffect(() => {
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
  }, [client, paneId, contextKey]);

  // A refresh keeps the last answer for this pane on screen until the next
  // one lands. Another pane's answer is never shown: its folder is not this one.
  const currentContext =
    ready && context?.paneId === paneId ? context : undefined;
  const contextPath = currentContext?.value?.path;
  const statusBase =
    ready && contextPath
      ? `${paneId}:${contextPath}:${refreshKey}:${statusKey}:`
      : "";
  const statusRequestKey = statusBase ? `${statusBase}${pollKey}` : "";
  useEffect(() => {
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
            paneId,
            path: contextPath,
            value: result,
          });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setStatus({
            key: statusRequestKey,
            paneId,
            path: contextPath,
            error:
              error instanceof Error ? error.message : "Could not load changes.",
          });
      });
    return () => controller.abort();
  }, [client, paneId, contextPath, statusRequestKey]);

  const currentStatus =
    status?.paneId === paneId && status.path === contextPath
      ? status
      : undefined;

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

  const contextPending = !!ready && context?.key !== contextKey;
  const statusPending =
    !!statusBase && !(status?.key.startsWith(statusBase) ?? false);

  return {
    client: ready ? client : null,
    paneId: ready ? paneId : null,
    unavailable,
    context: currentContext?.value,
    status: currentStatus?.value,
    loading: contextPending || statusPending,
    error: currentContext?.error ?? currentStatus?.error,
    refreshKey,
    refresh,
    refreshStatus,
  };
}
