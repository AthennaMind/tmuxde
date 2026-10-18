import { useCallback, useState } from "react";
import { GitBranch, GitGraph, RefreshCw, X } from "lucide-react";
import type { RepoCommit } from "@/protocol";
import { cn } from "@/shared/utils";
import { useRelayClient } from "@/features/connection/use-websocket";
import { useVisibleInterval } from "@/shared/use-visible-interval";
import { sameRoot, type RepoChange } from "./repo-change";
import { useConnectionStore } from "@/features/connection/connection-store";
import { commitTabId, useMainTabsStore, type GraphTab } from "@/features/workspace/main-tabs-store";
import { useRepoChangeCount, useRepoWatch, watchHealthy } from "./repo-watch-store";
import { useCommitLog } from "./use-commit-log";
import { HeaderButton } from "@/features/workspace/panel-header";
import { GraphList } from "./graph-list";
import { Notice } from "./repository-preview";

/** Log poll while no server watch covers the repository. */
const POLL_MS = 15_000;
/** Safety poll while the server watch pushes Git changes. */
const WATCHED_POLL_MS = 120_000;

function folderName(path: string): string {
  return path.replace(/\/+$/, "").split("/").pop() || path;
}

/**
 * Commit graph of every branch, tag and remote branch in the desktop main
 * area. A row opens the commit as its own tab.
 *
 * Stays on the repository it was opened for. A push that says HEAD or a ref
 * moved in that repository reloads the first page quietly. Index only
 * changes, such as `git add` or `git status`, leave it alone. A hidden graph
 * lets its watch go, so the server slot serves the repositories on screen.
 * It asks nothing and reloads the first page once when it comes back.
 */
export function GraphTabView({
  tab,
  active,
  className,
}: {
  tab: GraphTab;
  /** The tab is in front. */
  active: boolean;
  className?: string;
}) {
  const client = useRelayClient();
  const status = useConnectionStore((s) => s.status);
  const supported = useConnectionStore((s) => s.features.has("repo:graph"));
  const closeTab = useMainTabsStore((s) => s.closeTab);
  const connected = !!client && status === "connected";
  const usable = connected && supported ? client : null;
  const [refresh, setRefresh] = useState(0);
  const [poll, setPoll] = useState(0);
  // Hash last opened from this graph, while its tab stays open.
  const [opened, setOpened] = useState<string>();
  const selected = useMainTabsStore((s) =>
    opened && s.tabs.some((t) => t.id === commitTabId(opened, tab.machineId)) ? opened : undefined,
  );

  // Watch first, so its pushes count from the start. The root is known once
  // the first page names it. Only a graph in front holds a watch and counts
  // pushes. The server allows few watches per connection.
  const [root, setRoot] = useState<string | null>(null);
  const watch = useRepoWatch(active ? usable : null, root, {
    paneId: tab.paneId,
    path: tab.contextPath,
  });
  const matchRefs = useCallback(
    (change: RepoChange) => !!root && change.refs && sameRoot(change, root),
    [root],
  );
  const pushes = useRepoChangeCount(active && root ? matchRefs : null);
  const log = useCommitLog({
    client: usable,
    paneId: tab.paneId,
    path: tab.contextPath,
    root: tab.contextPath,
    refresh,
    tick: pushes + poll,
    all: true,
    active,
  });
  const logRoot = log.root ?? null;
  if (logRoot !== root) setRoot(logRoot);

  useVisibleInterval(() => setPoll((n) => n + 1), watchHealthy(watch) ? WATCHED_POLL_MS : POLL_MS, {
    enabled: active && !!root && !!usable,
    debounceMs: 1_000,
  });

  // Stable, so a render of this view does not render every row again.
  const open = useCallback(
    (commit: RepoCommit) => {
      setOpened(commit.hash);
      useMainTabsStore.getState().openCommit({
        machineId: tab.machineId,
        sessionName: tab.sessionName,
        paneId: tab.paneId,
        hash: commit.hash,
        subject: commit.subject,
        contextPath: tab.contextPath,
      });
    },
    [tab.machineId, tab.sessionName, tab.paneId, tab.contextPath],
  );
  const retry = () => setRefresh((n) => n + 1);
  const folder = folderName(root ?? tab.contextPath);

  return (
    <section
      aria-label={`Graph of ${folder}`}
      className={cn("flex min-h-0 min-w-0 flex-col bg-background", className)}
    >
      <div className="flex min-h-11 shrink-0 items-center gap-2 border-b ps-3 pe-1 font-chrome">
        <GitGraph className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
        <h2 className="shrink-0 text-[13px] font-medium">Graph</h2>
        <span
          className="min-w-0 truncate text-xs text-muted-foreground"
          title={root ?? tab.contextPath}
        >
          {folder}
        </span>
        {log.branch && (
          <span
            className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground"
            title={`Current branch ${log.branch}`}
          >
            <GitBranch className="h-3.5 w-3.5 shrink-0" aria-hidden />
            <span className="sr-only">Current branch </span>
            <span className="truncate">{log.branch}</span>
          </span>
        )}
        <span className="flex-1" />
        <HeaderButton label="Refresh graph" onClick={retry}>
          <RefreshCw
            className={cn("h-4 w-4", log.refreshing && "animate-spin motion-reduce:animate-none")}
          />
        </HeaderButton>
        <HeaderButton label="Close" onClick={() => closeTab(tab.id)}>
          <X className="h-4 w-4" />
        </HeaderButton>
      </div>
      <div className="min-h-0 flex-1 overflow-auto font-chrome">
        {!connected ? (
          <Notice>Connect to view the graph.</Notice>
        ) : !supported ? (
          <Notice>Update tmuxde on this machine to view the graph.</Notice>
        ) : log.loading ? (
          <Notice>Loading graph</Notice>
        ) : log.commits.length === 0 && log.error ? (
          <div className="px-4 py-6">
            <p role="alert" className="text-sm text-destructive">
              {log.error}
            </p>
            <button
              type="button"
              onClick={retry}
              className="mt-3 min-h-8 rounded-md border px-3 text-[13px] hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              Try again
            </button>
          </div>
        ) : log.root === null ? (
          <Notice>This folder is outside a Git repository.</Notice>
        ) : log.commits.length === 0 ? (
          <Notice>No commits yet.</Notice>
        ) : (
          <>
            <GraphList commits={log.commits} selected={selected} onOpen={open} />
            {log.error && <Notice error>{log.error}</Notice>}
            {log.more && (
              <div className="px-2 pb-3">
                <button
                  type="button"
                  onClick={log.loadMore}
                  disabled={log.loadingMore}
                  className="flex min-h-8 w-full items-center justify-center gap-2 rounded-md border text-[13px] text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-70 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                >
                  <RefreshCw
                    className={cn(
                      "h-3.5 w-3.5",
                      log.loadingMore ? "animate-spin motion-reduce:animate-none" : "hidden",
                    )}
                    aria-hidden
                  />
                  Load older commits
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}
