import { useState } from "react";
import { ChevronDown, ChevronRight, GitGraph, GitBranch } from "lucide-react";
import type { RepoCommit } from "@/protocol";
import type { WorkspaceChanges } from "./use-workspace-changes";
import { PanelIconButton } from "@/features/workspace/panel-header";
import { Notice as Note } from "@/shared/notice";
import { CommitList } from "./commit-log";
import { useCommitLog } from "./use-commit-log";
import type { RepositoryClient } from "./repository-request";
import type { RepositoryContext } from "./use-repository-state";
import { useRepoChangeCount, useRepoWatch } from "./repo-watch-store";
import { relativeTo } from "./repo-change";

interface HistoryProps {
  client: RepositoryClient;
  paneId: string;
  refresh: number;
  tick?: unknown;
  dense?: boolean;
  selected?: { hash: string; contextPath: string };
  onOpen: (root: string, commit: RepoCommit) => void;
  onGraph?: (root: string) => void;
}

export function GroupedHistory({
  context,
  workspace,
  ...props
}: HistoryProps & { context: RepositoryContext; workspace: WorkspaceChanges }) {
  return (
    <>
      {workspace.groups.map(({ root }, index) => (
        <HistoryGroup
          key={root}
          {...props}
          root={root}
          tick={root === context.root ? props.tick : undefined}
          label={relativeTo(context.root ?? context.path, root) || root.split("/").pop() || "/"}
          initiallyOpen={index < 4}
        />
      ))}
      {workspace.loading && <Note>Finding repositories…</Note>}
      {workspace.error && <Note error>{workspace.error}</Note>}
      {!workspace.groups.length && !workspace.loading && !workspace.error && (
        <Note>
          {workspace.supported
            ? "No Git repositories found."
            : "Update tmuxde on this machine to discover nested repositories."}
        </Note>
      )}
      {workspace.scanTruncated && (
        <Note>Repository scan incomplete. Open a pane in a subfolder to see more.</Note>
      )}
    </>
  );
}

function HistoryGroup({
  root,
  label,
  initiallyOpen,
  client,
  paneId,
  refresh,
  tick,
  dense,
  selected,
  onOpen,
  onGraph,
}: HistoryProps & { root: string; label: string; initiallyOpen: boolean }) {
  const [open, setOpen] = useState(initiallyOpen);
  useRepoWatch(client, open ? root : null, { paneId, path: root });
  const pushed = useRepoChangeCount((change) => change.root === root && change.refs);
  const log = useCommitLog({
    client,
    paneId,
    path: root,
    root,
    refresh: refresh + pushed,
    tick,
    active: open,
  });
  const branch = log.branch ?? (log.root === root ? "Detached HEAD" : null);
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <section aria-label={`History of ${label}`}>
      <div className="flex items-center border-b bg-surface-sunken px-1">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          title={root}
          className={`flex min-w-0 flex-1 items-center gap-1.5 px-1 text-start text-sm hover:bg-accent ${dense ? "min-h-8" : "min-h-11"}`}
        >
          <Chevron className="size-3.5 shrink-0" aria-hidden />
          <span className="truncate font-medium">{label}</span>
          {branch && (
            <span className="ms-auto flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
              <GitBranch className="size-3 shrink-0" aria-hidden />
              <span className="truncate">{branch}</span>
            </span>
          )}
        </button>
        {onGraph && (
          <PanelIconButton
            label={`Open graph for ${label}`}
            icon={GitGraph}
            onClick={() => onGraph(root)}
          />
        )}
      </div>
      {open && (
        <>
          {log.loading ? (
            <Note>Loading history…</Note>
          ) : log.root !== undefined && log.root !== root ? (
            <Note>Repository moved. Refresh history.</Note>
          ) : (
            <>
              <CommitList
                commits={log.commits}
                dense={dense}
                selected={selected?.contextPath === root ? selected.hash : undefined}
                onOpen={(commit) => onOpen(root, commit)}
              />
              {!log.error && !log.commits.length && <Note>No commits yet.</Note>}
              {log.more && (
                <button
                  type="button"
                  className="mx-2 my-1 min-h-9 rounded border px-2 text-sm hover:bg-accent"
                  disabled={log.loadingMore}
                  onClick={log.loadMore}
                >
                  Load older commits
                </button>
              )}
            </>
          )}
          {log.error && <Note error>{log.error}</Note>}
        </>
      )}
    </section>
  );
}
