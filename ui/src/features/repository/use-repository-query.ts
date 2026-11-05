import { useDirectoryWatch } from "@/features/files/use-directory-watch";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import type { RepoResult } from "@/protocol";
import { useSessionTreeStore } from "@/features/session/session-tree-store";
import { machineId } from "@/features/connection/machine-context";
import { useExplorerStore } from "@/features/workspace/explorer-store";
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
  // The pane is read when a request goes out, so a new pane alone sends
  // nothing for a key that leaves it out.
  const requestPane = useEffectEvent(() => query?.id ?? "");
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
  const [liveRefresh, setLiveRefresh] = useState(0);
  const revision = refresh + liveRefresh;
  const busy = useRef(false);
  const again = useRef(false);
  useDirectoryWatch(
    client,
    attached && query?.action === "list" ? (query.path ?? null) : null,
    () => {
      if (busy.current) again.current = true;
      else setLiveRefresh((value) => value + 1);
    },
  );
  useEffect(() => {
    if (key === "null" || !attached || client.status !== "connected") return;
    const machine = machineId();
    busy.current = true;
    again.current = false;
    const controller = new AbortController();
    repositoryRequest(
      client,
      { ...(JSON.parse(key) as RepositoryQuery), id: requestPane() },
      controller.signal,
    )
      .then((result) => {
        if (controller.signal.aborted) return;
        if (result.kind === "status") useExplorerStore.getState().reconcileGit(machine, result);
        setState({ key, refresh: revision, result });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setState({
            key,
            refresh: revision,
            error: error instanceof Error ? error.message : "Could not load files.",
          });
      })
      .finally(() => {
        if (controller.signal.aborted) return;
        busy.current = false;
        if (again.current) {
          again.current = false;
          setLiveRefresh((value) => value + 1);
        }
      });
    return () => {
      controller.abort();
      busy.current = false;
      again.current = false;
    };
  }, [attached, client, key, revision]);
  const current = state?.key === key && state.refresh === revision ? state : undefined;
  const shown =
    current ??
    (query !== null && (keepPrevious || (keepOnRefresh && state?.key === key)) ? state : undefined);
  return {
    result: shown?.result,
    error: shown?.error,
    loading: query !== null && !current,
  };
}
