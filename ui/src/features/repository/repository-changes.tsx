import { useMemo, useState } from "react";
import { ChevronRight, Folder, GitBranch, List, ListCollapse, ListTree } from "lucide-react";
import type { RepoResult } from "@/protocol";
import { cn } from "@/shared/utils";
import { buildChangeTree, type ChangeNode } from "./repository-tree";
import { RepositoryFileIcon } from "@/features/files/repository-file-icon";
import { machineId } from "@/features/connection/machine-context";
import { explorerTreeKey, useExplorerStore } from "@/features/workspace/explorer-store";
import { useExplorerFolders } from "@/features/workspace/use-explorer-folders";
import { ChangeContextMenu } from "./change-context-menu";
import { ChangeDiscardDialog } from "./change-discard-dialog";
import { useChangeActions } from "./use-change-actions";
import { ChangeCode } from "./change-code";

type ChangeMenu = ReturnType<typeof useChangeActions>["menu"];

type Scope = "staged" | "unstaged" | "untracked";
const SCOPE_LABELS = {
  staged: "Staged",
  unstaged: "Unstaged",
  untracked: "Untracked",
};
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

type ChangeEntry = Extract<RepoResult, { kind: "status" }>["entries"][number];
export function ChangesList({
  root,
  workdir,
  entries,
  onOpen,
  dense = false,
  branch,
}: {
  root: string;
  workdir: string;
  entries: ChangeEntry[];
  onOpen: (path: string, scope: Scope) => void;
  /** Mouse density for the desktop sidebar. Touch rows stay 44px. */
  dense?: boolean;
  /** Optional branch beside layout controls in the desktop sidebar. */
  branch?: string | null;
}) {
  const actions = useChangeActions(root, workdir, onOpen);
  const [view, setView] = useState(savedView);
  const selectView = (value: "list" | "tree") => {
    setView(value);
    try {
      localStorage.setItem(VIEW_KEY, value);
    } catch {
      /* Keep preference for this visit. */
    }
  };
  const groups: { scope: Scope; files: ChangeEntry[] }[] = [
    {
      scope: "unstaged",
      files: entries.filter(
        (entry) => entry.worktree !== " " && entry.worktree !== "?" && entry.worktree !== "!",
      ),
    },
    {
      scope: "staged",
      files: entries.filter(
        (entry) => entry.index !== " " && entry.index !== "?" && entry.index !== "!",
      ),
    },
    {
      scope: "untracked",
      files: entries.filter((entry) => entry.index === "?" || entry.worktree === "?"),
    },
  ];
  const collapseAll = () => {
    for (const { scope, files } of groups) {
      const folders = new Set<string>();
      const collect = (nodes: ChangeNode<ChangeEntry>[]) => {
        for (const node of nodes) {
          if (!node.children) continue;
          folders.add(node.path);
          collect(node.children);
        }
      };
      collect(buildChangeTree(files));
      if (!folders.size) continue;
      useExplorerStore
        .getState()
        .updateFolders(
          explorerTreeKey(machineId(), `changes:${scope}`, root, workdir),
          (previous) => new Set([...(previous ?? []), ...folders]),
        );
    }
  };
  return (
    <div
      key={`${machineId()}:${root}:${workdir}`}
      data-changes-list
      tabIndex={-1}
      className={dense ? "py-1" : "py-2"}
    >
      <div
        className={cn(
          "flex min-w-0 items-center justify-between gap-3",
          dense ? "px-3 pb-1" : "border-b px-3 pb-2",
        )}
      >
        {branch ? (
          <span className="flex min-w-0 items-center gap-2 text-[13px]" title={branch}>
            <GitBranch className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
            <span className="truncate">{branch}</span>
          </span>
        ) : (
          <span />
        )}
        <div className="flex shrink-0 items-center gap-1">
          {view === "tree" && (
            <button
              type="button"
              aria-label="Collapse all"
              title="Collapse all"
              onClick={collapseAll}
              disabled={!entries.some((entry) => entry.path.includes("/"))}
              className={cn(
                "flex shrink-0 items-center justify-center rounded text-muted-foreground enabled:hover:bg-accent/60 enabled:hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40",
                dense ? "h-7 w-7 pointer-coarse:h-11 pointer-coarse:w-11" : "h-11 w-11",
              )}
            >
              <ListCollapse className="h-4 w-4" aria-hidden />
            </button>
          )}
          <div
            role="group"
            aria-label="Changed file layout"
            className={cn(
              "flex shrink-0 items-center",
              dense ? "gap-0.5 rounded-md bg-muted/50 p-0.5" : "gap-1",
            )}
          >
            {(["list", "tree"] as const).map((value) => {
              const Icon = value === "tree" ? ListTree : List;
              const label = value === "tree" ? "Tree" : "List";
              return (
                <button
                  key={value}
                  type="button"
                  aria-label={dense ? `${label} view` : label}
                  title={`${label} view`}
                  aria-pressed={view === value}
                  onClick={() => selectView(value)}
                  className={cn(
                    "flex items-center justify-center gap-2 rounded text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    dense ? "h-7 w-7 pointer-coarse:h-11 pointer-coarse:w-11" : "min-h-11 px-3",
                    view === value
                      ? "bg-accent text-accent-foreground"
                      : "text-muted-foreground hover:bg-accent/60",
                  )}
                >
                  <Icon className="h-4 w-4" aria-hidden />
                  {!dense && label}
                </button>
              );
            })}
          </div>
        </div>
      </div>
      {actions.pending && !actions.confirmation && (
        <p role="status" className="px-3 py-1 text-xs text-muted-foreground">
          Updating files. {actions.completed} done.
        </p>
      )}
      {groups
        .filter((group) => group.files.length)
        .map(({ scope, files }) => (
          <section
            key={scope}
            aria-label={`${SCOPE_LABELS[scope]} files`}
            className={dense ? "mb-2" : "mb-3"}
          >
            <h3
              className={cn(
                "flex items-center justify-between text-[11px] font-semibold uppercase tracking-wider text-muted-foreground",
                // Dense lives in the sidebar, which sets the code face.
                dense ? "px-3 py-1.5 font-chrome" : "px-4 py-2 font-sans",
              )}
            >
              <span>{SCOPE_LABELS[scope]}</span>
              <span className="tabular-nums">{files.length}</span>
            </h3>
            {view === "tree" ? (
              <ChangeTree
                root={root}
                workdir={workdir}
                files={files}
                scope={scope}
                onOpen={onOpen}
                menu={actions.menu}
                dense={dense}
              />
            ) : (
              <ul>
                {files.map((entry) => (
                  <li key={entry.path}>
                    <ChangeButton
                      entry={entry}
                      scope={scope}
                      onOpen={onOpen}
                      dense={dense}
                      menu={actions.menu}
                    />
                  </li>
                ))}
              </ul>
            )}
          </section>
        ))}
      {actions.confirmation && (
        <ChangeDiscardDialog
          target={actions.confirmation}
          pending={actions.pending}
          completed={actions.completed}
          error={actions.error}
          onConfirm={actions.confirm}
          onClose={actions.close}
        />
      )}
    </div>
  );
}

function ChangeTree({
  root,
  workdir,
  files,
  scope,
  onOpen,
  menu,
  dense,
}: {
  root: string;
  workdir: string;
  files: ChangeEntry[];
  scope: Scope;
  onOpen: (path: string, scope: Scope) => void;
  menu: ChangeMenu;
  dense: boolean;
}) {
  const [collapsed, setCollapsed] = useExplorerFolders(
    explorerTreeKey(machineId(), `changes:${scope}`, root, workdir),
  );
  const nodes = useMemo(() => buildChangeTree(files), [files]);
  const renderNodes = (items: ChangeNode<ChangeEntry>[], depth = 0): React.ReactNode => (
    <ul>
      {items.map((node) => (
        <li key={node.path}>
          {node.children ? (
            <details
              open={!collapsed.has(node.path)}
              className="[&[open]>summary>svg:first-child]:rotate-90"
            >
              <ChangeContextMenu
                actions={menu(
                  files.filter((entry) => entry.path.startsWith(`${node.path}/`)),
                  scope,
                  node.path,
                  true,
                )}
              >
                <summary
                  data-change-path={node.path}
                  onClick={(event) => {
                    event.preventDefault();
                    setCollapsed((previous) => {
                      const next = new Set(previous);
                      if (next.has(node.path)) next.delete(node.path);
                      else next.add(node.path);
                      return next;
                    });
                  }}
                  className={cn(
                    "flex cursor-pointer list-none items-center gap-2 text-sm hover:bg-muted/60 [&::-webkit-details-marker]:hidden",
                    dense ? "min-h-7 px-3 py-0.5" : "min-h-11 px-4 py-2",
                  )}
                  style={{
                    paddingInlineStart: `${(dense ? 12 : 16) + Math.min(depth, 8) * 12}px`,
                  }}
                >
                  <ChevronRight className="h-3.5 w-3.5 shrink-0" />
                  <Folder className="h-4 w-4 shrink-0 text-term-path" />
                  <span className="min-w-0 flex-1 truncate" title={node.path}>
                    {node.name}
                  </span>
                  <span className="text-xs tabular-nums text-muted-foreground">{node.count}</span>
                </summary>
              </ChangeContextMenu>
              {renderNodes(node.children, depth + 1)}
            </details>
          ) : (
            <ChangeButton
              entry={node.entry!}
              scope={scope}
              onOpen={onOpen}
              menu={menu}
              depth={depth}
              basename
              dense={dense}
            />
          )}
        </li>
      ))}
    </ul>
  );
  return renderNodes(nodes);
}

function ChangeButton({
  entry,
  scope,
  onOpen,
  menu,
  depth = 0,
  basename = false,
  dense = false,
}: {
  entry: ChangeEntry;
  scope: Scope;
  onOpen: (path: string, scope: Scope) => void;
  menu: ChangeMenu;
  depth?: number;
  basename?: boolean;
  dense?: boolean;
}) {
  const code = scope === "untracked" ? "?" : scope === "staged" ? entry.index : entry.worktree;
  return (
    <ChangeContextMenu actions={menu([entry], scope, entry.path)}>
      <button
        data-change-path={entry.path}
        type="button"
        onClick={() => onOpen(entry.path, scope)}
        title={entry.originalPath ? `${entry.originalPath} → ${entry.path}` : entry.path}
        className={cn(
          "flex w-full items-center text-left hover:bg-muted/60 focus-visible:bg-muted",
          dense ? "min-h-7 gap-2 px-3 py-0.5" : "min-h-11 gap-3 px-4 py-2",
        )}
        style={{
          paddingInlineStart: `${(dense ? 12 : 16) + Math.min(depth, 8) * 12}px`,
        }}
      >
        <ChangeCode code={code} />
        <RepositoryFileIcon path={entry.path} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm">
            {basename ? entry.path.split("/").pop() : entry.path}
          </span>
          {entry.originalPath && (
            <span className="block truncate text-[11px] text-muted-foreground">
              from {entry.originalPath}
            </span>
          )}
        </span>
        <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      </button>
    </ChangeContextMenu>
  );
}
