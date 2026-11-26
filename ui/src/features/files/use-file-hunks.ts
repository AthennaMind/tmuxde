import { useEffect, useRef, useState } from "react";
import { get } from "@/features/connection/relay-registry";
import { useConnectionStore } from "@/features/connection/connection-store";
import { usePaneStore } from "@/features/panes/pane-store";
import { sameRoot } from "@/features/repository/repo-change";
import {
  useRepoWatchStore,
  useRepoWatch,
  watchHealthy,
} from "@/features/repository/repo-watch-store";
import { useRepositoryQuery } from "@/features/repository/use-repository-query";
import { useVisibleInterval } from "@/shared/use-visible-interval";
import type { FileHunk } from "./file-hunk";

const noHunks: FileHunk[] = [];

export function useFileHunks(
  machine: string,
  path: string | null,
  current: string,
): FileHunk[] | undefined {
  const client = get(machine);
  const paneId = usePaneStore((s) => s.activePaneId);
  const available = useConnectionStore(
    (s) => s.status === "connected" && s.features.has("repo:baseline"),
  );
  const [refresh, setRefresh] = useState(0);
  const query = useRepositoryQuery(
    client,
    available && paneId && path ? { action: "baseline", id: paneId, path } : null,
    refresh,
    { keepOnRefresh: true, retainResultOnError: true },
  );
  const baseline = query.result?.kind === "baseline" ? query.result : undefined;
  const root = baseline?.root;
  useEffect(() => {
    if (!root) return;
    return useRepoWatchStore.subscribe((state, previous) => {
      // Stage can finish after the first read and before the watch starts.
      if (state.roots[root]?.ok && state.roots[root] !== previous.roots[root]) {
        setRefresh((n) => n + 1);
        return;
      }
      const change = state.lastChange;
      if (!change || change === previous.lastChange || !sameRoot(change, root)) return;
      if (
        change.git ||
        change.truncated ||
        change.paths.some((p) => /(?:^|\/)\.git(?:ignore|attributes)$/.test(p))
      ) {
        setRefresh((n) => n + 1);
      }
    });
  }, [root]);
  const watch = useRepoWatch(client, root, { paneId, path: root ?? undefined });
  useVisibleInterval(
    () => {
      if (!query.loading) setRefresh((n) => n + 1);
    },
    watchHealthy(watch) && !query.error ? 120_000 : 15_000,
    { enabled: available && !!paneId && !!path, debounceMs: 0 },
  );
  const original = query.error ? undefined : baseline?.content;
  const worker = useRef<Worker | null>(null);
  useEffect(
    () => () => {
      worker.current?.terminate();
      worker.current = null;
    },
    [],
  );
  const [result, setResult] = useState<{ original: string; current: string; hunks: FileHunk[] }>();
  useEffect(() => {
    if (original == null || current === original || current.includes("\0")) return;
    let computing = false;
    const timer = setTimeout(() => {
      computing = true;
      worker.current ??= new Worker(new URL("./file-diff.worker.ts", import.meta.url), {
        type: "module",
      });
      worker.current.onmessage = (event: MessageEvent<FileHunk[]>) => {
        computing = false;
        setResult({ original, current, hunks: event.data });
      };
      worker.current.postMessage({ original, current });
    }, 150);
    return () => {
      clearTimeout(timer);
      // A pending comparison belongs to the previous buffer.
      if (computing) {
        worker.current?.terminate();
        worker.current = null;
      }
    };
  }, [current, original]);
  if (original == null || current === original || current.includes("\0")) return noHunks;
  // Monaco keeps its tracked decorations while the next comparison runs.
  return result?.current === current && result.original === original ? result.hunks : undefined;
}
