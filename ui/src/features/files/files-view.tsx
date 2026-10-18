import { QuickOpenTrigger } from "./quick-open-trigger";
import { useMemo, useRef, useState } from "react";
import {
  ClipboardCopy,
  Download,
  Upload,
  FileText,
  GitBranch,
  ListCollapse,
  Pencil,
  RefreshCw,
  Search,
  TextCursorInput,
} from "lucide-react";
import { UploadControl, type UploadPicker } from "./transfer-controls";
import { startDownload, useTransferStore } from "./transfer-store";
import { machineId } from "@/features/connection/machine-context";
import type { FileEntry } from "@/protocol";
import { cn } from "@/shared/utils";
import { copyFailureReason, copyText } from "@/shared/clipboard";
import { shortenPath } from "@/shared/tmux-labels";
import { useAlertStore } from "@/shared/alert-store";
import { useFileStore } from "./file-store";
import { useUiStore } from "@/features/workspace/ui-store";
import { Button } from "@/components/ui/button";
import { isReadOnly, useConnectionStore } from "@/features/connection/connection-store";
import { useMainTabsStore } from "@/features/workspace/main-tabs-store";
import { getTerminalHandle } from "@/features/terminal/terminal-handle";
import { RepositoryFileIcon } from "./repository-file-icon";
import { useRepositoryQuery } from "@/features/repository/use-repository-query";
import { changeTouchesFolder } from "@/features/repository/repo-change";
import { useRepoChangeCount } from "@/features/repository/repo-watch-store";
import type { RepositoryClient } from "@/features/repository/repository-request";
import { PanelHeader, PanelIconButton } from "@/features/workspace/panel-header";
import { TreeRow, type TreeAction, type TreeRowModel } from "@/features/workspace/tree-row";
import { useTreeKeyboard } from "@/features/workspace/use-tree-keyboard";
import type { RepositoryState } from "@/features/repository/use-repository-state";

type ChangeCode = { code: string; label: string };

const CODE_LABELS: Record<string, string> = {
  M: "Modified",
  A: "Added",
  D: "Deleted",
  R: "Renamed",
  C: "Copied",
  U: "Conflict",
  T: "Type changed",
  "?": "Untracked",
};

function codeClass(code: string) {
  return code === "D"
    ? "text-term-removed"
    : code === "A" || code === "?"
      ? "text-term-added"
      : "text-term-path";
}

function basename(path: string) {
  return path.replace(/\/$/, "").split("/").pop() || path;
}

/** Folders from `root` down to `path`, both included. */
function ancestors(root: string, path: string): string[] {
  const base = root.replace(/\/$/, "");
  if (path !== base && !path.startsWith(`${base}/`)) return [base];
  const out = [base];
  const rest = path.slice(base.length).split("/").filter(Boolean);
  let current = base;
  for (const part of rest) {
    current = `${current}/${part}`;
    out.push(current);
  }
  return out;
}

interface TreeState {
  client: RepositoryClient;
  paneId: string;
  refreshKey: number;
  filter: string;
  expanded: Set<string>;
  toggle: (path: string) => void;
  changes: Map<string, ChangeCode>;
  changedDirs: Set<string>;
  focusKey: string | null;
  setFocusKey: (key: string) => void;
  menuKey: string | null;
  setMenuKey: (key: string | null) => void;
  actionsFor: (entry: FileEntry) => TreeAction[];
  open: (entry: FileEntry) => void;
}

/**
 * Folder tree of the active pane's repository, or of its folder outside one.
 *
 * Opens at the pane's folder. A file opens as a tab beside the terminal.
 */
export function FilesView({ repo }: { repo: RepositoryState }) {
  const capabilities = useConnectionStore((s) => s.capabilities);
  const readOnly = isReadOnly(capabilities);
  const { client, paneId, context, status } = repo;
  const root = context ? (context.root ?? context.path) : null;
  const [filter, setFilter] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const [menuKey, setMenuKey] = useState<string | null>(null);
  const { ref: treeRef, onKeyDown: onTreeKeyDown } = useTreeKeyboard();
  const uploaded = useTransferStore((s) => s.revisions[machineId()] ?? 0);
  const uploadPicker = useRef<UploadPicker>(null);

  // A new pane folder opens the tree down to it. In the same repository the
  // folders opened by hand stay open. This adjusts state during render, so
  // the first frame for a new folder already shows it open.
  const contextPath = context?.path;
  const [openedFor, setOpenedFor] = useState<{ root: string | null; path?: string }>({
    root: null,
  });
  if (openedFor.root !== root || openedFor.path !== contextPath) {
    setOpenedFor({ root, path: contextPath });
    if (root && contextPath) {
      const path = ancestors(root, contextPath);
      setExpanded((prev) => (prev.has(root) ? new Set([...prev, ...path]) : new Set(path)));
      setFocusKey(null);
    }
  }

  const { changes, changedDirs } = useMemo(() => {
    const files = new Map<string, ChangeCode>();
    const dirs = new Set<string>();
    if (!status?.root) return { changes: files, changedDirs: dirs };
    const base = status.root.replace(/\/$/, "");
    for (const entry of status.entries) {
      const code =
        entry.index === "?" || entry.worktree === "?"
          ? "?"
          : entry.worktree !== " "
            ? entry.worktree
            : entry.index;
      const full = `${base}/${entry.path}`;
      files.set(full, { code, label: CODE_LABELS[code] ?? "Changed" });
      let dir = full.slice(0, full.lastIndexOf("/"));
      while (dir.length > base.length) {
        dirs.add(dir);
        dir = dir.slice(0, dir.lastIndexOf("/"));
      }
    }
    return { changes: files, changedDirs: dirs };
  }, [status]);

  const toggle = (path: string) => {
    // Focus inside a closing folder moves to the folder.
    if (expanded.has(path) && focusKey?.startsWith(`${path}/`)) {
      setFocusKey(path);
      requestAnimationFrame(() =>
        treeRef.current
          ?.querySelector<HTMLElement>(`[data-tree-row="${CSS.escape(path)}"]`)
          ?.focus(),
      );
    }
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const insertPath = (path: string) => {
    const terminal = getTerminalHandle();
    if (!terminal) return;
    useMainTabsStore.getState().showTerminal();
    terminal.paste(/\s/.test(path) ? `'${path.replace(/'/g, "'\\''")}'` : path);
    terminal.focus();
  };

  const actionsFor = (entry: FileEntry): TreeAction[] => [
    ...(entry.type === "file"
      ? [{ label: "Download", icon: Download, onSelect: () => startDownload(entry.path) }]
      : []),
    ...(entry.type === "directory" && !readOnly && (!capabilities || capabilities.files === "write")
      ? [
          {
            label: "Upload files here",
            icon: Upload,
            onSelect: () => uploadPicker.current?.choose(entry.path),
          },
        ]
      : []),
    ...(entry.type === "directory"
      ? []
      : [
          {
            label: "Open",
            icon: FileText,
            onSelect: () => open(entry),
          },
        ]),
    {
      label: "Copy path",
      icon: ClipboardCopy,
      onSelect: () =>
        void copyText(entry.path).then((ok) =>
          useAlertStore
            .getState()
            .push(ok ? "success" : "error", ok ? "Copied path" : copyFailureReason()),
        ),
    },
    ...(readOnly
      ? []
      : [
          ...(entry.type === "file"
            ? [
                {
                  // The Monaco editor, which saves back to the machine.
                  // Open shows a read only preview in a tab.
                  label: "Open in editor",
                  icon: Pencil,
                  onSelect: () => useFileStore.getState().openEditor(entry.path),
                },
              ]
            : []),
          {
            label: "Insert path in terminal",
            icon: TextCursorInput,
            onSelect: () => insertPath(entry.path),
          },
        ]),
  ];

  const open = (entry: FileEntry) => {
    if (!paneId) return;
    useMainTabsStore.getState().openFile({
      paneId,
      path: entry.path,
      size: entry.type === "file" ? entry.size : undefined,
      symlink: entry.type === "symlink",
    });
  };

  const branch = status?.branch ?? context?.branch ?? (context?.root ? "Detached HEAD" : null);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PanelHeader
        title={
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate" title={root ?? undefined}>
              {root ? basename(root) : "Files"}
            </span>
            {branch && (
              <span
                className="flex min-w-0 items-center gap-1 text-xs font-normal text-muted-foreground"
                title={`Branch ${branch}`}
              >
                <GitBranch className="h-3 w-3 shrink-0" aria-hidden />
                <span className="truncate">{branch}</span>
              </span>
            )}
          </span>
        }
      >
        {contextPath && <UploadControl directory={contextPath} pickerRef={uploadPicker} />}
        <PanelIconButton
          label="Collapse folders"
          icon={ListCollapse}
          onClick={() => root && setExpanded(new Set([root]))}
          disabled={!root}
        />
        <PanelIconButton
          label="Refresh files"
          icon={RefreshCw}
          onClick={repo.refresh}
          disabled={!client}
          spinning={repo.loading}
        />
      </PanelHeader>
      <QuickOpenTrigger />

      {repo.unavailable ? (
        <Note>{repo.unavailable}</Note>
      ) : repo.error && !context ? (
        <div className="space-y-3 px-3 py-4 text-sm">
          <div role="alert" className="space-y-2">
            <p className="break-words text-destructive">{repo.error}</p>
            <p className="text-muted-foreground">
              {repo.error === "Access denied: path outside allowed directories"
                ? "Files follow active pane. Select a pane in an allowed folder from Sessions, or ask machine owner to allow this folder."
                : "Try refreshing files. If this keeps failing, select another pane from Sessions."}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => useUiStore.getState().showSidebarView("sessions")}
            >
              Show sessions
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={repo.refresh}
              disabled={!client || repo.loading}
            >
              Retry
            </Button>
          </div>
        </div>
      ) : !client || !paneId || !root ? (
        <Note>Finding pane folder</Note>
      ) : (
        <>
          <div className="shrink-0 px-2 py-2">
            <label className="flex h-8 items-center gap-2 rounded-md border border-input bg-background px-2 focus-within:ring-1 focus-within:ring-ring">
              <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
              <input
                aria-label="Filter open folders"
                placeholder="Filter open folders"
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") setFilter("");
                }}
                className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              />
            </label>
          </div>
          <div className="min-h-0 flex-1 overflow-auto px-1.5 pb-2">
            <div
              ref={treeRef}
              data-tree
              role="group"
              aria-label={`Files in ${basename(root)}`}
              onKeyDown={onTreeKeyDown}
              className="space-y-px"
            >
              <FolderChildren
                key={root}
                path={root}
                depth={0}
                parentKey={null}
                state={{
                  client,
                  paneId,
                  refreshKey: repo.refreshKey + uploaded,
                  filter: filter.trim().toLocaleLowerCase(),
                  expanded,
                  toggle,
                  changes,
                  changedDirs,
                  focusKey,
                  setFocusKey,
                  menuKey,
                  setMenuKey,
                  actionsFor,
                  open,
                }}
              />
            </div>
          </div>
          <p
            className="shrink-0 truncate border-t px-3 py-2 text-xs text-muted-foreground"
            title={context?.path}
          >
            Follows active pane · {shortenPath(context?.path ?? "")}
          </p>
        </>
      )}
    </div>
  );
}

function FolderChildren({
  path,
  depth,
  parentKey,
  state,
}: {
  path: string;
  depth: number;
  parentKey: string | null;
  state: TreeState;
}) {
  // A push that touches this folder lists it again, quietly. Both counts
  // only grow, so their sum changes whenever either does.
  const pushed = useRepoChangeCount((change) => changeTouchesFolder(change, path));
  // Another pane or a refresh asks again for the same folder. The old rows
  // stay until the answer lands instead of collapsing to "Loading".
  const listing = useRepositoryQuery(
    state.client,
    { id: state.paneId, action: "list", path },
    state.refreshKey + pushed,
    { keepPrevious: true },
  );
  const indent = 4 + depth * 14 + 22;

  if (listing.loading && !listing.result && !listing.error)
    return (
      <div
        className="flex h-7 items-center text-xs text-muted-foreground"
        style={{ paddingInlineStart: indent }}
      >
        Loading
      </div>
    );
  if (listing.error)
    return (
      <div
        role="alert"
        className="flex min-h-7 items-center text-xs text-destructive"
        style={{ paddingInlineStart: indent }}
      >
        {listing.error}
      </div>
    );

  const result = listing.result?.kind === "list" ? listing.result : undefined;
  const entries = [...(result?.entries ?? [])].sort((a, b) => {
    const dirA = a.type === "directory" ? 0 : 1;
    const dirB = b.type === "directory" ? 0 : 1;
    return dirA - dirB || a.name.localeCompare(b.name);
  });
  const visible = state.filter
    ? entries.filter(
        (entry) =>
          entry.name.toLocaleLowerCase().includes(state.filter) ||
          (entry.type === "directory" && state.expanded.has(entry.path)),
      )
    : entries;

  if (!visible.length)
    return (
      <div
        className="flex h-7 items-center text-xs text-muted-foreground"
        style={{ paddingInlineStart: indent }}
      >
        {state.filter ? "No matches" : "Empty folder"}
      </div>
    );

  // The first row of the tree takes Tab until another row has focus.
  const isRoot = depth === 0;
  const tabStopKey = state.focusKey ?? (isRoot ? visible[0]!.path : null);

  return (
    <>
      {visible.map((entry) => {
        const isDir = entry.type === "directory";
        const open = isDir && state.expanded.has(entry.path);
        const change = state.changes.get(entry.path);
        const dirChanged = isDir && state.changedDirs.has(entry.path);
        const row: TreeRowModel = {
          key: entry.path,
          parentKey,
          depth,
          label: entry.name,
          title: entry.path,
          icon: (
            <RepositoryFileIcon
              path={entry.path}
              type={entry.type}
              className="h-3.5 w-3.5 shrink-0"
            />
          ),
          expandable: isDir,
          expanded: open,
          toggle: isDir ? () => state.toggle(entry.path) : undefined,
          activate: () => (isDir ? state.toggle(entry.path) : state.open(entry)),
          meta: change ? (
            <span
              className={cn("w-3 text-center font-mono font-semibold", codeClass(change.code))}
              aria-label={change.label}
              title={change.label}
            >
              {change.code}
            </span>
          ) : dirChanged ? (
            <span
              className="me-1 h-1.5 w-1.5 rounded-full bg-term-path"
              aria-label="Contains changes"
              title="Contains changes"
            />
          ) : undefined,
          menu: state.actionsFor(entry),
        };
        return (
          <FileTreeEntry
            key={entry.path}
            row={row}
            open={open}
            state={state}
            tabStop={tabStopKey === entry.path}
          />
        );
      })}
      {result?.truncated && (
        <div
          className="flex h-7 items-center text-xs text-muted-foreground"
          style={{ paddingInlineStart: indent }}
        >
          Some entries not shown
        </div>
      )}
    </>
  );
}

function FileTreeEntry({
  row,
  open,
  state,
  tabStop,
}: {
  row: TreeRowModel;
  open: boolean;
  state: TreeState;
  tabStop: boolean;
}) {
  return (
    <>
      <TreeRow
        row={row}
        tabStop={tabStop}
        onFocusRow={state.setFocusKey}
        menuOpen={state.menuKey === row.key}
        onMenuOpenChange={(value) => state.setMenuKey(value ? row.key : null)}
        renaming={false}
        onRenameStart={() => {}}
        onRenameEnd={() => {}}
      />
      {open && (
        <FolderChildren path={row.key} depth={row.depth + 1} parentKey={row.key} state={state} />
      )}
    </>
  );
}

function Note({ children, error = false }: { children: React.ReactNode; error?: boolean }) {
  return (
    <p
      role={error ? "alert" : "status"}
      className={cn("px-3 py-4 text-sm", error ? "text-destructive" : "text-muted-foreground")}
    >
      {children}
    </p>
  );
}
