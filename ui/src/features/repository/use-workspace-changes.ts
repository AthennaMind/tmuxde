import { useEffect, useMemo, useState } from "react";
import { useConnectionStore } from "@/features/connection/connection-store";
import { machineId } from "@/features/connection/machine-context";
import { useExplorerStore } from "@/features/workspace/explorer-store";
import { useVisibleInterval } from "@/shared/use-visible-interval";
import { useRepoWatchStore } from "./repo-watch-store";
import { repositoryRequest, type RepositoryClient } from "./repository-request";
import type { RepositoryContext, RepositoryStatus } from "./use-repository-state";
import { useRepositoryQuery } from "./use-repository-query";

type Status = { status?: RepositoryStatus; error?: string };
/** Load each child status from its own root. Coalesce watch events while a read is in flight. */
export function useWorkspaceChanges(
  client: RepositoryClient | null,
  paneId: string | null,
  context: RepositoryContext | undefined,
  parent: RepositoryStatus | undefined,
  refresh: number,
  visible: boolean,
) {
  const supported = useConnectionStore((s) => s.features.has("repo:roots"));
  const [revision, setRevision] = useState(0);
  useVisibleInterval(() => setRevision((n) => n + 1), 30_000, {
    enabled: visible && !!context && supported,
  });
  const primary = context?.root;
  const path = primary ?? context?.path;
  const query = useRepositoryQuery(
    client,
    supported && path && paneId ? { id: paneId, path, action: "roots" } : null,
    refresh + revision,
    { keepOnRefresh: true },
  );
  const discovery = query.result?.kind === "roots" ? query.result : undefined;
  const nested = useMemo(
    () => discovery?.roots.filter((root) => root !== primary) ?? [],
    [discovery, primary],
  );
  const [loaded, setLoaded] = useState<{
    path: string;
    client: RepositoryClient;
    values: Record<string, Status>;
  }>();
  useEffect(() => {
    if (!client || !paneId || !path || !nested.length) return;
    const controller = new AbortController();
    const pending = new Set(nested);
    const owner = machineId();
    const active = new Set<string>();
    let timer: ReturnType<typeof setTimeout>;
    const read = async (root: string) => {
      try {
        const status = await repositoryRequest(
          client,
          { id: paneId, path: root, action: "status" },
          controller.signal,
        );
        if (controller.signal.aborted) return;
        if (status.kind !== "status" || status.root !== root)
          throw new Error("Repository moved. Refresh Changes.");
        useExplorerStore.getState().reconcileGit(owner, status);
        save(root, { status });
      } catch (error) {
        if (!controller.signal.aborted)
          save(root, { error: error instanceof Error ? error.message : "Could not load changes." });
      } finally {
        active.delete(root);
        pump();
      }
    };
    const save = (root: string, value: Status) => {
      setLoaded((previous) => ({
        path,
        client,
        values: {
          ...(previous?.client === client && previous.path === path ? previous.values : {}),
          [root]: value,
        },
      }));
    };
    function pump() {
      if (controller.signal.aborted) return;
      for (const root of pending) {
        if (active.size >= 4) break;
        if (active.has(root)) continue;
        pending.delete(root);
        active.add(root);
        void read(root);
      }
    }
    pump();
    const stop = useRepoWatchStore.subscribe((next, prev) => {
      const change = next.lastChange;
      if (!change || change === prev.lastChange || !nested.includes(change.root)) return;
      pending.add(change.root);
      clearTimeout(timer);
      timer = setTimeout(pump, 180);
    });
    return () => {
      controller.abort();
      clearTimeout(timer);
      stop();
    };
  }, [client, paneId, path, nested]);
  const values = loaded?.path === path && loaded?.client === client ? loaded?.values : undefined;
  const groups = [
    ...(primary
      ? [{ root: primary, status: parent?.root === primary ? parent : undefined, error: undefined }]
      : []),
    ...nested.map((root) => ({ root, ...values?.[root] })),
  ];
  return {
    groups,
    count: groups.reduce((n, g) => n + (g.status?.entries.length ?? 0), 0),
    truncated: discovery?.truncated || groups.some((g) => g.status?.truncated),
    scanTruncated: discovery?.truncated,
    loading: query.loading && !discovery,
    error: query.error,
    supported,
  };
}
export type WorkspaceChanges = ReturnType<typeof useWorkspaceChanges>;
