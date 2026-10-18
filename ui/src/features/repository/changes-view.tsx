import { GitBranch, GitCompareArrows, RefreshCw } from "lucide-react";
import { cn } from "@/shared/utils";
import { ChangesList } from "./repository-changes";
import { useMainTabsStore } from "@/features/workspace/main-tabs-store";
import { PanelHeader, PanelIconButton } from "@/features/workspace/panel-header";
import type { RepositoryState } from "./use-repository-state";

/** Working tree changes of the active pane's repository. A file opens its diff as a tab. */
export function ChangesView({ repo }: { repo: RepositoryState }) {
  const { context, status, paneId } = repo;
  const count = status?.entries.length ?? 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PanelHeader
        title={
          <span className="flex items-center gap-2">
            Changes
            {count > 0 && (
              <span className="rounded bg-muted px-1.5 text-xs font-normal tabular-nums text-muted-foreground">
                {count}
                {status?.truncated ? "+" : ""}
              </span>
            )}
          </span>
        }
      >
        <PanelIconButton
          label="Refresh changes"
          icon={RefreshCw}
          onClick={repo.refreshStatus}
          disabled={!repo.client}
          spinning={repo.loading}
        />
      </PanelHeader>

      <BranchRow repo={repo} />

      {status?.root && count > 0 && (
        <div className="shrink-0 border-b px-3 py-2">
          <button
            type="button"
            disabled={!repo.client || !paneId}
            onClick={() => {
              if (!paneId || !status.root) return;
              useMainTabsStore.getState().openChanges({
                paneId,
                contextPath: status.root,
              });
            }}
            className="flex min-h-8 w-full items-center justify-center gap-2 rounded-md border px-3 text-[13px] hover:bg-accent disabled:opacity-50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <GitCompareArrows className="h-4 w-4" aria-hidden />
            View all changes
          </button>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto">
        {repo.unavailable ? (
          <Note>{repo.unavailable}</Note>
        ) : repo.error ? (
          <Note error>{repo.error}</Note>
        ) : !status ? (
          <Note>Loading changes</Note>
        ) : !status.root ? (
          <Note>Pane folder is outside a Git repository.</Note>
        ) : count === 0 ? (
          <div className="px-3 py-6">
            <GitCompareArrows className="mb-3 h-5 w-5 text-muted-foreground" aria-hidden />
            <p className="text-sm font-medium">Working tree is clean</p>
            <p className="mt-1 text-sm text-muted-foreground">
              No staged, unstaged or untracked files.
            </p>
          </div>
        ) : (
          <ChangesList
            dense
            entries={status.entries}
            onOpen={(path, scope) => {
              if (!paneId || !context) return;
              useMainTabsStore.getState().openFile({
                paneId,
                path,
                scope,
                contextPath: context.path,
                root: status.root,
              });
            }}
          />
        )}
        {status?.truncated && <Note>Change list shortened. Some files are not shown.</Note>}
      </div>
    </div>
  );
}

/** Branch of the active pane's repository, under a Changes or History header. */
export function BranchRow({ repo }: { repo: RepositoryState }) {
  const { context, status } = repo;
  const branch = status?.branch ?? context?.branch ?? (context?.root ? "Detached HEAD" : null);
  if (!branch) return null;
  return (
    <div
      className="flex shrink-0 items-center gap-2 border-b px-3 py-2 text-sm"
      title={context?.root ?? undefined}
    >
      <GitBranch className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
      <span className="truncate">{branch}</span>
    </div>
  );
}

export function Note({ children, error = false }: { children: React.ReactNode; error?: boolean }) {
  return (
    <p
      role={error ? "alert" : "status"}
      className={cn("px-3 py-4 text-sm", error ? "text-destructive" : "text-muted-foreground")}
    >
      {children}
    </p>
  );
}
