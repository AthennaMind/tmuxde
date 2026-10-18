import { useEffect, useMemo, useState } from "react";
import { ChevronRight, Folder, List, ListTree } from "lucide-react";
import type { RepoResult } from "@/protocol";
import { cn } from "@/shared/utils";
import { buildChangeTree, type ChangeNode } from "./repository-tree";
import { RepositoryFileIcon } from "@/features/files/repository-file-icon";

type Scope = "staged" | "unstaged" | "untracked";
const SCOPE_LABELS = {
  staged: "Staged",
  unstaged: "Unstaged",
  untracked: "Untracked",
};
const VIEW_KEY = "tmuxde-change-view";

type ChangeEntry = Extract<RepoResult, { kind: "status" }>["entries"][number];
export function ChangesList({
  entries,
  onOpen,
  dense = false,
}: {
  entries: ChangeEntry[];
  onOpen: (path: string, scope: Scope) => void;
  /** Mouse density for the desktop sidebar. Touch rows stay 44px. */
  dense?: boolean;
}) {
  const [view, setView] = useState<"list" | "tree">("list");
  useEffect(() => {
    try {
      if (localStorage.getItem(VIEW_KEY) === "tree") setView("tree");
    } catch {
      /* Storage can be unavailable. */
    }
  }, []);
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
  return (
    <div className={dense ? "py-1" : "py-2"}>
      <div
        role="group"
        aria-label="Changed file layout"
        className={cn("flex justify-end gap-1 border-b", dense ? "px-2 pb-1" : "px-3 pb-2")}
      >
        {(["list", "tree"] as const).map((value) => {
          const Icon = value === "tree" ? ListTree : List;
          return (
            <button
              key={value}
              type="button"
              aria-pressed={view === value}
              onClick={() => selectView(value)}
              className={cn(
                "flex items-center gap-2 rounded-md text-sm",
                dense ? "min-h-8 px-2" : "min-h-11 px-3",
                view === value
                  ? "bg-muted text-foreground"
                  : "text-muted-foreground hover:bg-muted/60",
              )}
            >
              <Icon className="h-4 w-4" />
              {value === "tree" ? "Tree" : "List"}
            </button>
          );
        })}
      </div>
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
              <ChangeTree files={files} scope={scope} onOpen={onOpen} dense={dense} />
            ) : (
              <ul>
                {files.map((entry) => (
                  <li key={entry.path}>
                    <ChangeButton entry={entry} scope={scope} onOpen={onOpen} dense={dense} />
                  </li>
                ))}
              </ul>
            )}
          </section>
        ))}
    </div>
  );
}

function ChangeTree({
  files,
  scope,
  onOpen,
  dense,
}: {
  files: ChangeEntry[];
  scope: Scope;
  onOpen: (path: string, scope: Scope) => void;
  dense: boolean;
}) {
  const nodes = useMemo(() => buildChangeTree(files), [files]);
  const renderNodes = (items: ChangeNode<ChangeEntry>[], depth = 0): React.ReactNode => (
    <ul>
      {items.map((node) => (
        <li key={node.path}>
          {node.children ? (
            <details open className="[&[open]>summary>svg:first-child]:rotate-90">
              <summary
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
              {renderNodes(node.children, depth + 1)}
            </details>
          ) : (
            <ChangeButton
              entry={node.entry!}
              scope={scope}
              onOpen={onOpen}
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
  depth = 0,
  basename = false,
  dense = false,
}: {
  entry: ChangeEntry;
  scope: Scope;
  onOpen: (path: string, scope: Scope) => void;
  depth?: number;
  basename?: boolean;
  dense?: boolean;
}) {
  const code = scope === "untracked" ? "?" : scope === "staged" ? entry.index : entry.worktree;
  return (
    <button
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
  );
}

/** Git status letter, colored, with its meaning for screen readers. */
export function ChangeCode({ code }: { code: string }) {
  return (
    <span
      className={cn(
        "w-4 shrink-0 font-mono text-xs font-semibold",
        code === "D"
          ? "text-term-removed"
          : code === "A" || code === "?"
            ? "text-term-added"
            : "text-term-path",
      )}
    >
      <span aria-hidden>{code}</span>
      <span className="sr-only">{changeLabel(code)}</span>
    </span>
  );
}

function changeLabel(code: string) {
  return (
    (
      {
        M: "Modified",
        A: "Added",
        D: "Deleted",
        R: "Renamed",
        C: "Copied",
        U: "Conflict",
        T: "Type changed",
        "?": "Untracked",
      } as Record<string, string>
    )[code] ?? "Changed"
  );
}
