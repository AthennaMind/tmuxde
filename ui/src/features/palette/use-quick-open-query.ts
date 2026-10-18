import { useEffect, useRef, useState } from "react";
import type { RepoResult } from "@/protocol";
import {
  repositoryRequest,
  type RepositoryClient,
  type RepositoryQuery,
} from "@/features/repository/repository-request";

type Result = Exclude<RepoResult, { kind: "error" }>;

/** Key every response so old results disappear before effects run. */
export function useQuickOpenQuery(
  client: RepositoryClient | null,
  query: RepositoryQuery | null,
  refresh: number,
  delay = 0,
) {
  const key = JSON.stringify([query, refresh]);
  const [state, setState] = useState<{
    key: string;
    client: RepositoryClient;
    result?: Result;
    error?: string;
  }>();
  const pending = useRef<Promise<unknown> | null>(null);
  const active = useRef<AbortController | null>(null);
  useEffect(() => () => active.current?.abort(), [client]);
  useEffect(() => {
    const [request] = JSON.parse(key) as [RepositoryQuery | null, number];
    if (!client || !request) return;
    let stale = false;
    const timer = setTimeout(async () => {
      // Let the current scan finish, then send only the latest query.
      // Aborting a browser listener cannot stop a remote filesystem scan.
      await pending.current;
      if (stale) return;
      const controller = new AbortController();
      active.current = controller;
      pending.current = repositoryRequest(client, request, controller.signal)
        .then((result) => {
          if (!stale && !controller.signal.aborted) setState({ key, client, result });
        })
        .catch((error: unknown) => {
          if (!stale && !controller.signal.aborted)
            setState({
              key,
              client,
              error: error instanceof Error ? error.message : "Could not find files. Try again.",
            });
        });
    }, delay);
    return () => {
      clearTimeout(timer);
      stale = true;
    };
  }, [client, key, delay]);
  const current = state?.key === key && state.client === client ? state : undefined;
  return {
    result: current?.result,
    error: current?.error,
    loading: !!client && !!query && !current,
  };
}
