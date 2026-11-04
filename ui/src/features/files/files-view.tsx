import { FileContextMenu } from "./file-context-menu";
import { FileDeleteDialog, type DeleteTarget } from "./file-delete-dialog";
import { FileNameInput } from "./file-name-input";
import { renameFileEntry } from "./file-move";
import { useFileMoves } from "./use-file-moves";
import { FileMoveDialog } from "./file-move-dialog";
import { pathWithin } from "./file-drafts";
import { createFileEntry, newEntryPath, type CreateKind } from "./file-create-request";
import { useMemo, useRef, useState } from "react";
import {
  ClipboardCopy,
  Download,
  Upload,
  FileText,
  FilePlus,
  FolderPlus,
  FolderInput,
  GitBranch,
  ListCollapse,
  Pencil,
  PanelLeftClose,
  RefreshCw,
  TextCursorInput,
  Trash2,
} from "lucide-react";
import { UploadControl, type UploadPicker } from "./transfer-controls";
import { startDownload, useTransferStore } from "./transfer-store";
import { machineId } from "@/features/connection/machine-context";
import type { FileEntry } from "@/protocol";
import { cn } from "@/shared/utils";
import { copyFailureReason, copyText } from "@/shared/clipboard";
import { shortenPath } from "@/shared/tmux-labels";
import { useAlertStore } from "@/shared/alert-store";
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
import { PanelHeader } from "@/features/workspace/panel-header";
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

type NameTarget = {
  client: RepositoryClient;
  machine: string;
  paneId: string;
  directory: string;
} & ({ kind: CreateKind; entry?: never } | { kind: "rename"; entry: FileEntry });

type Naming = {
  target: NameTarget;
  submit: (name: string, signal: AbortSignal) => Promise<void>;
  cancel: () => void;
  pendingChanged: (pending: boolean) => void;
};

interface TreeState {
  naming: Naming | null;
  moves: ReturnType<typeof useFileMoves>;
  client: RepositoryClient;
  paneId: string;
  refreshKey: number;
  expanded: Set<string>;
  toggle: (path: string) => void;
  changes: Map<string, ChangeCode>;
  changedDirs: Set<string>;
  focusKey: string | null;
  setFocusKey: (key: string) => void;
  rename: (entry: FileEntry) => void;
  remove: (entry: FileEntry) => void;
  folderActions: (path: string) => TreeAction[];
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
  const [nameTarget, setNameTarget] = useState<NameTarget | null>(null);
  const [namingPending, setNamingPending] = useState(false);
  if (
    nameTarget &&
    (nameTarget.client !== client ||
      nameTarget.paneId !== paneId ||
      nameTarget.machine !== machineId())
  )
    setNameTarget(null);
  const [created, setCreated] = useState(0);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const { ref: treeRef, onKeyDown: onTreeKeyDown } = useTreeKeyboard();
  const focusTree = () => {
    const target =
      treeRef.current?.querySelector<HTMLElement>('[data-tree-row][tabindex="0"]') ??
      treeRef.current?.closest<HTMLElement>("[data-file-tree-root]");
    target?.focus({ preventScroll: true });
  };
  const uploaded = useTransferStore((s) => s.revisions[machineId()] ?? 0);
  const uploadPicker = useRef<UploadPicker>(null);
  const onMoved = (from: string, to: string) => {
    setCreated((value) => value + 1);
    setExpanded(
      (previous) =>
        new Set([
          ...[...previous].map((path) =>
            pathWithin(path, from) ? to + path.slice(from.length) : path,
          ),
          ...ancestors(root ?? "/", to.slice(0, to.lastIndexOf("/")) || "/"),
        ]),
    );
    setFocusKey(to);
    repo.refresh();
  };
  const moves = useFileMoves(client, onMoved);

  // A new pane folder opens the tree down to it. In the same repository the
  // folders opened by hand stay open. This adjusts state during render, so
  // the first frame for a new folder already shows it open.
  const contextPath = context?.path;
  const [openedFor, setOpenedFor] = useState<{ root: string | null; path?: string }>({
    root: null,
  });
  if (openedFor.root !== root || openedFor.path !== contextPath) {
    setOpenedFor({ root, path: contextPath });
    setNameTarget(null);
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
    if (namingPending) return;
    if (nameTarget && expanded.has(path) && pathWithin(nameTarget.directory, path))
      setNameTarget(null);
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

  const canCreate =
    client?.status === "connected" &&
    !readOnly &&
    (!capabilities || capabilities.files === "write");
  const cancelNaming = () => {
    setNameTarget(null);
    requestAnimationFrame(focusTree);
  };
  const startCreate = (kind: CreateKind, directory: string) => {
    if (!canCreate || !client || !paneId || namingPending || moves.moving) return;
    setExpanded((previous) => new Set([...previous, ...ancestors(root ?? directory, directory)]));
    setNameTarget({ kind, directory, machine: machineId(), paneId, client });
  };
  const rename = (entry: FileEntry) => {
    if (!moves.allowed || !client || !paneId || namingPending || moves.moving) return;
    setFocusKey(entry.path);
    setNameTarget({
      kind: "rename",
      entry,
      directory: entry.path.slice(0, entry.path.lastIndexOf("/")) || "/",
      machine: machineId(),
      paneId,
      client,
    });
  };
  const submitName = async (name: string, signal: AbortSignal) => {
    const target = nameTarget;
    if (!target || target.client !== client || target.machine !== machineId() || !canCreate)
      throw new Error("Connect to change files.");
    const path = newEntryPath(target.directory, name);
    if (target.kind === "rename") {
      if (!moves.allowed || moves.moving) throw new Error("Wait for current move to finish.");
      await renameFileEntry(target.client, target.machine, target.entry.path, path, signal);
      if (signal.aborted) return;
      onMoved(target.entry.path, path);
    } else {
      await createFileEntry(target.client, path, target.kind, signal);
      if (signal.aborted) return;
      setCreated((value) => value + 1);
      if (target.kind === "folder") setExpanded((previous) => new Set([...previous, path]));
      setFocusKey(path);
      repo.refresh();
      if (target.kind === "file")
        useMainTabsStore
          .getState()
          .openFile({ machineId: target.machine, paneId: target.paneId, path });
    }
    setNameTarget(null);
    if (target.kind !== "file") requestAnimationFrame(focusTree);
  };
  const naming: Naming | null =
    nameTarget &&
    nameTarget.client === client &&
    nameTarget.machine === machineId() &&
    nameTarget.paneId === paneId
      ? {
          target: nameTarget,
          submit: submitName,
          cancel: cancelNaming,
          pendingChanged: setNamingPending,
        }
      : null;
  const collapse = () => {
    if (!root || namingPending) return;
    setNameTarget(null);
    setExpanded(new Set([root]));
  };
  const remove = (entry: FileEntry) => {
    if (canCreate && client && !namingPending)
      setDeleteTarget({ entry, client, machine: machineId() });
  };
  const copyPath = (path: string) =>
    void copyText(path).then((ok) =>
      useAlertStore
        .getState()
        .push(ok ? "success" : "error", ok ? "Copied path" : copyFailureReason()),
    );
  const createActions = (directory: string): TreeAction[] =>
    canCreate
      ? [
          { label: "New file", icon: FilePlus, onSelect: () => startCreate("file", directory) },
          {
            label: "New folder",
            icon: FolderPlus,
            onSelect: () => startCreate("folder", directory),
          },
          {
            label: "Upload files here",
            icon: Upload,
            onSelect: () => uploadPicker.current?.choose(directory),
          },
        ]
      : [];
  const folderActions = (path: string): TreeAction[] => [
    ...createActions(path),
    { label: "Refresh", icon: RefreshCw, separated: canCreate, onSelect: repo.refresh },
    {
      label: "Collapse folders",
      icon: ListCollapse,
      onSelect: collapse,
    },
    { label: "Copy path", icon: ClipboardCopy, separated: true, onSelect: () => copyPath(path) },
    {
      label: "Hide sidebar",
      icon: PanelLeftClose,
      separated: true,
      onSelect: () => useUiStore.getState().toggleSidebar(),
    },
  ];
  const actionsFor = (entry: FileEntry): TreeAction[] => [
    ...(entry.type !== "directory"
      ? [{ label: "Open", icon: FileText, onSelect: () => open(entry) }]
      : []),
    ...createActions(
      entry.type === "directory"
        ? entry.path
        : entry.path.slice(0, entry.path.lastIndexOf("/")) || "/",
    ),
    ...(moves.allowed
      ? [
          {
            label: "Rename…",
            icon: Pencil,
            separated: true,
            shortcut: "F2",
            onSelect: () => rename(entry),
          },
          {
            label: "Move to folder…",
            icon: FolderInput,
            onSelect: () => {
              if (!namingPending) {
                setNameTarget(null);
                moves.setSelection(entry);
              }
            },
          },
        ]
      : []),
    {
      label: "Copy path",
      icon: ClipboardCopy,
      separated: true,
      onSelect: () => copyPath(entry.path),
    },
    ...(entry.type === "file"
      ? [{ label: "Download", icon: Download, onSelect: () => startDownload(entry.path) }]
      : []),
    ...(!readOnly
      ? [
          {
            label: "Insert path in terminal",
            icon: TextCursorInput,
            onSelect: () => insertPath(entry.path),
          },
        ]
      : []),
    ...(canCreate
      ? [
          {
            label: "Delete",
            icon: Trash2,
            destructive: true,
            separated: true,
            shortcut: "Delete",
            onSelect: () => remove(entry),
          },
        ]
      : []),
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
      {moves.selection && <FileMoveDialog moves={moves} />}
      {deleteTarget && deleteTarget.client === client && deleteTarget.machine === machineId() && (
        <FileDeleteDialog
          target={deleteTarget}
          onClose={() => setDeleteTarget(null)}
          onReturnFocus={focusTree}
          onDeleted={() => {
            setDeleteTarget(null);
            setCreated((value) => value + 1);
            setFocusKey(null);
            repo.refresh();
          }}
        />
      )}
      <PanelHeader
        showSidebarToggle={false}
        title={
          <span className="flex min-w-0 items-center gap-2">
            <span
              {...moves.dropProps(root)}
              className={cn(
                "truncate",
                moves.over === root && "bg-primary/15 outline outline-1 outline-primary",
              )}
              title={root ?? undefined}
            >
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
      />
      {contextPath && (
        <UploadControl directory={contextPath} pickerRef={uploadPicker} showButton={false} />
      )}
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
          <FileContextMenu actions={folderActions(root)}>
            <div
              data-file-tree-root
              tabIndex={0}
              aria-label="File tree background"
              {...moves.dropProps(root)}
              className={cn(
                "min-h-0 flex-1 overflow-auto px-1.5 pb-2",
                moves.over === root &&
                  "bg-primary/10 outline outline-1 -outline-offset-1 outline-primary",
              )}
            >
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
                    naming,
                    client,
                    paneId,
                    moves,
                    refreshKey: repo.refreshKey + uploaded + created,
                    expanded,
                    toggle,
                    changes,
                    changedDirs,
                    focusKey,
                    setFocusKey,
                    rename,
                    remove,
                    folderActions,
                    actionsFor,
                    open,
                  }}
                />
              </div>
            </div>
          </FileContextMenu>
          <p
            className="shrink-0 truncate border-t px-3 py-2 text-xs text-muted-foreground"
            title={context?.path}
          >
            {moves.moving ? "Moving… · " : ""}Follows active pane ·{" "}
            {shortenPath(context?.path ?? "")}
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
  const naming = state.naming;
  const creator =
    naming && naming.target.kind !== "rename" && naming.target.directory === path ? (
      <FileNameInput
        key={naming.target.kind}
        type={naming.target.kind === "folder" ? "directory" : "file"}
        depth={depth}
        onSubmit={naming.submit}
        onCancel={naming.cancel}
        onPendingChange={naming.pendingChanged}
      />
    ) : null;

  if (listing.loading && !listing.result && !listing.error)
    return (
      <>
        {creator}
        <div
          className="flex h-7 items-center text-xs text-muted-foreground"
          style={{ paddingInlineStart: indent }}
        >
          Loading
        </div>
      </>
    );
  if (listing.error)
    return (
      <>
        {creator}
        <div
          role="alert"
          className="flex min-h-7 items-center text-xs text-destructive"
          style={{ paddingInlineStart: indent }}
        >
          {listing.error}
        </div>
      </>
    );

  const result = listing.result?.kind === "list" ? listing.result : undefined;
  const entries = [...(result?.entries ?? [])].sort((a, b) => {
    const dirA = a.type === "directory" ? 0 : 1;
    const dirB = b.type === "directory" ? 0 : 1;
    return dirA - dirB || a.name.localeCompare(b.name);
  });
  if (!entries.length)
    return (
      <>
        {creator}
        {!creator && (
          <FileContextMenu actions={state.folderActions(path)}>
            <div
              className="flex h-7 items-center text-xs text-muted-foreground"
              style={{ paddingInlineStart: indent }}
            >
              Empty folder
            </div>
          </FileContextMenu>
        )}
      </>
    );

  // The first row of the tree takes Tab until another row has focus.
  const isRoot = depth === 0;
  const tabStopKey = state.focusKey ?? (isRoot ? entries[0]!.path : null);

  return (
    <>
      {creator}
      {entries.map((entry) => {
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
        };
        return (
          <FileTreeEntry
            key={entry.path}
            row={row}
            entry={entry}
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
  entry,
  open,
  state,
  tabStop,
}: {
  row: TreeRowModel;
  entry: FileEntry;
  open: boolean;
  state: TreeState;
  tabStop: boolean;
}) {
  return (
    <>
      {state.naming?.target.kind === "rename" && state.naming.target.entry.path === entry.path ? (
        <FileNameInput
          initialName={entry.name}
          type={entry.type}
          depth={row.depth}
          onSubmit={state.naming.submit}
          onCancel={state.naming.cancel}
          onPendingChange={state.naming.pendingChanged}
        />
      ) : (
        <FileContextMenu actions={state.actionsFor(entry)}>
          <div
            onContextMenu={() => state.setFocusKey(entry.path)}
            onKeyDown={(event) => {
              if (event.defaultPrevented) return;
              if (event.key === "F2") {
                event.preventDefault();
                state.rename(entry);
              }
              if (event.key === "Delete") {
                event.preventDefault();
                state.remove(entry);
              }
            }}
            {...(!state.naming ? state.moves.dragProps(entry) : {})}
            {...state.moves.dropProps(entry.type === "directory" ? entry.path : null)}
            className={cn(
              "rounded-md",
              state.moves.over === entry.path &&
                "bg-primary/15 outline outline-1 -outline-offset-1 outline-primary",
            )}
          >
            <TreeRow
              row={row}
              tabStop={tabStop}
              onFocusRow={state.setFocusKey}
              menuOpen={false}
              onMenuOpenChange={() => {}}
              renaming={false}
              onRenameStart={() => {}}
              onRenameEnd={() => {}}
            />
          </div>
        </FileContextMenu>
      )}
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
