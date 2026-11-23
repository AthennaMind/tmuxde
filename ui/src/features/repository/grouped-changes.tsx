import { useState } from "react";
import { ChevronDown, ChevronRight, GitBranch, GitCompareArrows } from "lucide-react";
import { PanelIconButton } from "@/features/workspace/panel-header";
import { Notice } from "@/shared/notice";
import { ChangesList, ChangesToolbar } from "./repository-changes";
import type { ChangeScope } from "./change-actions";
import { relativeTo } from "./repo-change";
import { useRepoWatch } from "./repo-watch-store";
import type { RepositoryClient } from "./repository-request";
import type { RepositoryContext } from "./use-repository-state";
import type { WorkspaceChanges } from "./use-workspace-changes";

const VIEW_KEY = "tmuxde-change-view";

/** The saved layout, read once when the list mounts. */
function savedView(): "list" | "tree" {
  try {
    return localStorage.getItem(VIEW_KEY) === "tree" ? "tree" : "list";
  } catch {
    /* Storage can be unavailable. */
    return "list";
  }
}

function useChangesLayout() {
  const [view, setView] = useState(savedView);
  const selectView = (value: "list" | "tree") => {
    setView(value);
    try {
      localStorage.setItem(VIEW_KEY, value);
    } catch {
      /* Keep preference for this visit. */
    }
  };
  return { view, selectView };
}

interface Props {
  workspace: WorkspaceChanges;
  context: RepositoryContext;
  client: RepositoryClient;
  paneId: string;
  dense?: boolean;
  onOpen: (root: string, path: string, scope: ChangeScope) => void;
  onOpenAll: (root: string) => void;
  parentError?: string;
  onReveal?: (path: string) => void;
}

export function GroupedChanges({ workspace, ...props }: Props) {
  const { view, selectView } = useChangesLayout();
  return (
    <>
      {workspace.count > 0 && (
        <ChangesToolbar
          groups={workspace.groups}
          workdir={props.context.path}
          dense={props.dense}
          view={view}
          onSelect={selectView}
        />
      )}
      {workspace.groups.map((group, index) => (
        <ChangeGroup
          key={group.root}
          group={group}
          initiallyOpen={index < 4}
          view={view}
          {...props}
        />
      ))}
      {workspace.loading && <Notice>Finding repositories…</Notice>}
      {workspace.error && <Notice error>{workspace.error}</Notice>}
      {!workspace.loading && !workspace.error && !workspace.groups.length && (
        <Notice>No Git repositories found.</Notice>
      )}
      {workspace.truncated && <Notice>Some changes may be missing.</Notice>}
    </>
  );
}

function ChangeGroup({
  group,
  view,
  initiallyOpen,
  context,
  client,
  paneId,
  dense,
  onOpen,
  onOpenAll,
  onReveal,
  parentError,
}: Omit<Props, "workspace"> & {
  group: WorkspaceChanges["groups"][number];
  view: "tree" | "list";
  initiallyOpen: boolean;
}) {
  const { root, status } = group;
  const error = group.error ?? (root === context.root ? parentError : undefined);
  const [open, setOpen] = useState(initiallyOpen);
  useRepoWatch(root !== context.root && open ? client : null, root, { paneId, path: root });
  const label = relativeTo(context.root ?? context.path, root) || root.split("/").pop() || "/";
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <section aria-label={`Changes in ${label}`}>
      <div className="flex items-center gap-1 border-b bg-surface-sunken px-1">
        <button
          type="button"
          aria-expanded={open}
          title={root}
          onClick={() => setOpen(!open)}
          className={`flex min-w-0 flex-1 items-center gap-1.5 px-1 text-start text-sm hover:bg-accent ${dense ? "min-h-8" : "min-h-11"}`}
        >
          <Chevron className="size-3.5 shrink-0" aria-hidden />
          <span className="truncate font-medium">{label}</span>
          {status && (
            <>
              <span className="ms-auto flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
                <GitBranch className="size-3 shrink-0" aria-hidden />
                <span className="truncate">{status.branch ?? "Detached HEAD"}</span>
              </span>
              <span className="text-xs tabular-nums">{status.entries.length}</span>
            </>
          )}
        </button>
        {!!status?.entries.length && (
          <PanelIconButton
            label={`View all changes in ${label}`}
            icon={GitCompareArrows}
            onClick={() => onOpenAll(root)}
          />
        )}
      </div>
      {open &&
        (error ? (
          <Notice error>{error}</Notice>
        ) : !status ? (
          <Notice>Loading changes…</Notice>
        ) : status.entries.length ? (
          <ChangesList
            view={view}
            root={root}
            workdir={context.path}
            onReveal={onReveal}
            filesRoot={context.root ?? context.path}
            entries={status.entries}
            dense={dense}
            onOpen={(path, scope) => onOpen(root, path, scope)}
          />
        ) : (
          <p className="px-3 py-2 text-sm text-muted-foreground">Working tree is clean</p>
        ))}
    </section>
  );
}
