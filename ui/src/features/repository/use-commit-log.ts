import { useCallback, useEffect, useRef, useState } from "react";
import type { RepoCommit } from "@/protocol";
import { useSessionTreeStore } from "@/features/session/session-tree-store";
import { FirstPageGate, keepOlderPages } from "./commit-log-pages";
import { repositoryRequest, type RepositoryClient } from "./repository-request";

export interface CommitLog {
  commits: RepoCommit[];
  more: boolean;
  /** First page in flight with nothing to show yet. */
  loading: boolean;
  loadingMore: boolean;
  /** A refresh someone asked for is in flight. Polls never set this. */
  refreshing: boolean;
  error?: string;
  /** Repository root the first page named. Null outside Git. */
  root?: string | null;
  /** Current branch the first page named. Null on a detached HEAD. */
  branch?: string | null;
  loadMore: () => void;
}

/**
 * Commit history from HEAD of the repository at `root`, a page at a time.
 *
 * Keyed by repository root, so moving between panes of one repository keeps
 * the list. `refresh` and `tick` ask for the first page again. When that
 * page still continues into the pages loaded before, as `keepOlderPages`
 * checks, they stay. With `all` it walks every branch, tag and remote
 * branch.
 *
 * One first page request runs at a time. A `tick` or `refresh` while one is
 * in flight marks the log stale, and one more request runs after the
 * answer. While `active` is false nothing goes out, and one request runs
 * once it turns true again. An abort in the browser does not stop Git on
 * the server, so a stream of pushes must not start a request each.
 */
export function useCommitLog({
  client,
  paneId,
  path,
  root,
  refresh,
  tick,
  all = false,
  active = true,
}: {
  client: RepositoryClient | null;
  paneId: string | null;
  /** Pane folder the repository was found from. */
  path: string | undefined;
  root: string | null | undefined;
  refresh: number;
  /** Any value that changes on each status poll. */
  tick: unknown;
  /** Every branch, tag and remote branch, not only HEAD. */
  all?: boolean;
  /**
   * The list is on screen. A hidden one asks nothing, and asks once when it
   * comes back.
   */
  active?: boolean;
}): CommitLog {
  const attached = useSessionTreeStore((s) => s.attachedSession !== null);
  const key = client && paneId && path && root && attached ? `${all ? "all" : "head"}:${root}` : "";
  const [state, setState] = useState<{
    key: string;
    commits: RepoCommit[];
    more: boolean;
    error?: string;
    root?: string | null;
    branch?: string | null;
  }>();
  const [loadingMore, setLoadingMore] = useState(false);
  // The last first page request that ended: the `refresh` value it carried,
  // and a count. `refresh` differs from it while one loads. Each end sets a
  // new value, so the request effect runs again and sends what was marked
  // while that request was in flight.
  const [answered, setAnswered] = useState({ refresh, count: 0 });
  const pending = useRef<AbortController | null>(null);

  // The first page request in flight, if any, and when to send the next.
  const flight = useRef<{ key: string; controller: AbortController } | null>(null);
  const [gate] = useState(() => new FirstPageGate());
  // Key of the last answer, so a remount asks again.
  const loaded = useRef("");
  // What the last run of the request effect saw.
  const seen = useRef({ key: "", refresh, poll: tick });

  // The only place a first page request goes out. A pane switch inside one
  // repository runs it again, but marks nothing, so it asks nothing.
  useEffect(() => {
    const last = seen.current;
    // A folder change blanks status until the next answer. Only an answer is
    // a poll, or the gap would ask twice.
    const poll = tick === undefined ? last.poll : tick;
    seen.current = { key, refresh, poll };
    // A different repository, or none, drops the request for the old one.
    if (flight.current && flight.current.key !== key) {
      flight.current.controller.abort();
      flight.current = null;
      gate.settle();
    }
    if (!key || !client || !paneId || !path) return;
    // Nothing answered for this key and nothing on the way, as after a
    // remount.
    const unanswered = loaded.current !== key && flight.current?.key !== key;
    if (last.key !== key || last.refresh !== refresh || last.poll !== poll || unanswered)
      gate.mark();
    if (!gate.take(active)) return;
    const controller = new AbortController();
    flight.current = { key, controller };
    repositoryRequest(
      client,
      { id: paneId, action: "log", path, ...(all ? { all: true } : {}) },
      controller.signal,
    )
      .then((result) => {
        if (controller.signal.aborted || result.kind !== "log") return;
        const { root: logRoot, branch } = result;
        setState((prev) => {
          const kept = prev?.key === key ? keepOlderPages(prev.commits, result.commits) : null;
          if (kept && prev) return { key, commits: kept, more: prev.more, root: logRoot, branch };
          return { key, commits: result.commits, more: result.more, root: logRoot, branch };
        });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        const message = error instanceof Error ? error.message : "Could not load history.";
        setState((prev) =>
          prev?.key === key
            ? { ...prev, error: message }
            : { key, commits: [], more: false, error: message },
        );
      })
      .finally(() => {
        if (flight.current?.controller !== controller) return;
        flight.current = null;
        gate.settle();
        loaded.current = key;
        setAnswered((prev) => ({ refresh, count: prev.count + 1 }));
      });
  }, [key, refresh, tick, active, client, paneId, path, all, gate, answered]);

  useEffect(
    () => () => {
      flight.current?.controller.abort();
      flight.current = null;
      gate.settle();
    },
    [gate],
  );

  // A different repository drops a page request still in flight.
  useEffect(() => {
    return () => {
      pending.current?.abort();
      pending.current = null;
      setLoadingMore(false);
    };
  }, [key]);

  const current = state?.key === key ? state : undefined;
  const loadMore = useCallback(() => {
    if (!current?.more || pending.current || !client || !paneId || !path) return;
    const controller = new AbortController();
    pending.current = controller;
    setLoadingMore(true);
    repositoryRequest(
      client,
      {
        id: paneId,
        action: "log",
        path,
        skip: current.commits.length,
        ...(all ? { all: true } : {}),
      },
      controller.signal,
    )
      .then((result) => {
        if (controller.signal.aborted || result.kind !== "log") return;
        setState((prev) => {
          if (prev?.key !== key) return prev;
          const known = new Set(prev.commits.map((c) => c.hash));
          return {
            ...prev,
            commits: [...prev.commits, ...result.commits.filter((c) => !known.has(c.hash))],
            more: result.more,
            error: undefined,
          };
        });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setState((prev) =>
          prev?.key === key
            ? {
                ...prev,
                error: error instanceof Error ? error.message : "Could not load older commits.",
              }
            : prev,
        );
      })
      .finally(() => {
        if (pending.current !== controller) return;
        pending.current = null;
        setLoadingMore(false);
      });
  }, [current, key, client, paneId, path, all]);

  return {
    commits: current?.commits ?? [],
    more: current?.more ?? false,
    loading: !!key && !current,
    loadingMore,
    refreshing: !!key && answered.refresh !== refresh,
    error: current?.error,
    root: current?.root,
    branch: current?.branch,
    loadMore,
  };
}
