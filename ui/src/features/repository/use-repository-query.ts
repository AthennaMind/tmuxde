import { useEffect, useRef, useState } from "react";
import type { RepoResult } from "@/protocol";
import { useSessionTreeStore } from "@/features/session/session-tree-store";
import {
  isPaneFree,
  repositoryRequest,
  type RepositoryClient,
  type RepositoryQuery,
} from "./repository-request";

/**
 * Repository queries, shared by the mobile repository browser, the desktop
 * sidebar and desktop file tabs.
 */
export type RepositoryResult = Exclude<RepoResult, { kind: "error" }>;

/**
 * `keepPrevious` leaves the last answer on screen while the next one loads.
 * Only for callers whose query names the same thing across changes, such as
 * one folder of the sidebar tree asked again for another pane.
 *
 * `keepOnRefresh` does that only when the query is the same and just
 * `refresh` moved, as a quiet reload after a change on disk does. A new
 * query still starts empty.
 */
export function useRepositoryQuery(
  client: RepositoryClient,
  query: RepositoryQuery | null,
  refresh: number,
  {
    keepPrevious = false,
    keepOnRefresh = false,
  }: { keepPrevious?: boolean; keepOnRefresh?: boolean } = {},
) {
  // An absolute path answers the same through any pane, so the pane stays out
  // of the key. Moving between panes then asks nothing again.
  const key = JSON.stringify(query && isPaneFree(query) ? { ...query, id: undefined } : query);
  const paneId = useRef(query?.id);
  paneId.current = query?.id;
  // The relay refuses repository requests until a new socket has attached.
  // Waiting for that, and asking again after it, clears an error left by a
  // reconnect. A switch between sessions keeps this true and asks nothing.
  const attached = useSessionTreeStore((s) => s.attachedSession !== null);
  const [state, setState] = useState<{
    key: string;
    refresh: number;
    result?: RepositoryResult;
    error?: string;
  }>();
  useEffect(() => {
    if (key === "null" || !attached) return;
    const controller = new AbortController();
    repositoryRequest(
      client,
      { ...(JSON.parse(key) as RepositoryQuery), id: paneId.current ?? "" },
      controller.signal,
    )
      .then((result) => {
        if (!controller.signal.aborted) setState({ key, refresh, result });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setState({
            key,
            refresh,
            error: error instanceof Error ? error.message : "Could not load files.",
          });
      });
    return () => controller.abort();
  }, [attached, client, key, refresh]);
  const current = state?.key === key && state.refresh === refresh ? state : undefined;
  const shown =
    current ??
    (query !== null && (keepPrevious || (keepOnRefresh && state?.key === key)) ? state : undefined);
  return {
    result: shown?.result,
    error: shown?.error,
    loading: query !== null && !current,
  };
}
