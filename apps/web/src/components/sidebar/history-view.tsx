"use client";

import { useState } from "react";
import { History, RefreshCw } from "lucide-react";
import { cn } from "@repo/ui/lib/utils";
import { CommitList, useCommitLog } from "@/components/files/commit-log";
import { useConnectionStore } from "@/stores/connection-store";
import { useMainTabsStore } from "@/stores/main-tabs-store";
import { BranchRow, Note } from "./changes-view";
import { PanelHeader, PanelIconButton } from "./panel-header";
import type { RepositoryState } from "./use-repository-state";

/** Commits from HEAD of the active pane's repository. A commit opens as a tab. */
export function HistoryView({ repo }: { repo: RepositoryState }) {
  const [refresh, setRefresh] = useState(0);
  const supported = useConnectionStore((s) => s.features.has("repo:history"));
  const { context, paneId } = repo;
  const log = useCommitLog({
    client: supported ? repo.client : null,
    paneId,
    path: context?.path,
    root: context?.root,
    refresh,
    // Each status poll also checks whether HEAD moved.
    tick: repo.status,
  });
  const selected = useMainTabsStore((s) => {
    const tab = s.tabs.find((t) => t.id === s.active);
    return tab?.kind === "commit" ? tab.hash : undefined;
  });

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PanelHeader title="History">
        <PanelIconButton
          label="Refresh history"
          icon={RefreshCw}
          onClick={() => setRefresh((n) => n + 1)}
          disabled={!repo.client || !supported}
          spinning={log.refreshing}
        />
      </PanelHeader>

      <BranchRow repo={repo} />

      <div className="min-h-0 flex-1 overflow-auto">
        {repo.unavailable ? (
          <Note>{repo.unavailable}</Note>
        ) : !supported ? (
          <Note>Update tmuxde on this machine to browse history.</Note>
        ) : repo.error ? (
          <Note error>{repo.error}</Note>
        ) : !context || (context.root && log.loading) ? (
          <Note>Loading history</Note>
        ) : !context.root ? (
          <Note>Pane folder is outside a Git repository.</Note>
        ) : log.commits.length === 0 && log.error ? (
          <>
            <Note error>{log.error}</Note>
            <button
              type="button"
              onClick={() => setRefresh((n) => n + 1)}
              className="mx-3 min-h-8 rounded-md border px-3 text-[13px] hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              Try again
            </button>
          </>
        ) : log.commits.length === 0 ? (
          <div className="px-3 py-6">
            <History
              className="mb-3 h-5 w-5 text-muted-foreground"
              aria-hidden
            />
            <p className="text-sm font-medium">No commits yet</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Commits on this branch show here after the first one.
            </p>
          </div>
        ) : (
          <>
            <CommitList
              dense
              commits={log.commits}
              selected={selected}
              onOpen={(commit) => {
                if (!paneId || !context) return;
                useMainTabsStore.getState().openCommit({
                  paneId,
                  hash: commit.hash,
                  subject: commit.subject,
                  contextPath: context.path,
                });
              }}
            />
            {log.error && <Note error>{log.error}</Note>}
            {log.more && (
              <div className="px-1.5 pb-2">
                <button
                  type="button"
                  onClick={log.loadMore}
                  disabled={log.loadingMore}
                  className="flex min-h-8 w-full items-center justify-center gap-2 rounded-md border text-[13px] text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-70 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                >
                  <RefreshCw
                    className={cn(
                      "h-3.5 w-3.5",
                      log.loadingMore
                        ? "animate-spin motion-reduce:animate-none"
                        : "hidden",
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
    </div>
  );
}
