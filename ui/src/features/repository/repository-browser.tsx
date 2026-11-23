import { useFileMoves } from "@/features/files/use-file-moves";
import { FileMoveDialog } from "@/features/files/file-move-dialog";
import { FileCreateDialog, type CreateTarget } from "@/features/files/file-create-dialog";
import { useFileStore } from "@/features/files/file-store";
import { useQuickOpenStore } from "@/features/files/quick-open-store";
import { useEffect, useId, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  ChevronRight,
  GitCommitHorizontal,
  RefreshCw,
  FilePlus,
  FolderPlus,
  FolderInput,
  WrapText,
  X,
} from "lucide-react";
import { DownloadButton, UploadControl } from "@/features/files/transfer-controls";
import { useTransferStore } from "@/features/files/transfer-store";
import { machineId } from "@/features/connection/machine-context";
import type { FileEntry } from "@/protocol";
import { cn } from "@/shared/utils";
import { Button } from "@/components/ui/button";
import { useRelayClient } from "@/features/connection/use-websocket";
import { GroupedHistory } from "./grouped-history";
import { lazyComponent } from "@/shared/lazy-component";
import { CommitDetail } from "./commit-view";
import { useRepositoryHistory, type RepositoryView } from "./repository-history";
import { RepositoryNavigationSurface } from "./repository-navigation-surface";
import { GroupedChanges } from "./grouped-changes";
import { useWorkspaceChanges } from "./use-workspace-changes";
import { RepositoryFileIcon } from "@/features/files/repository-file-icon";
import { FilePreview } from "./repository-preview";
import { Notice } from "@/shared/notice";
import { useRepositoryQuery } from "./use-repository-query";
import { formatFileSize } from "@/features/files/file-utils";
import { dirname, isMarkdownPath } from "@/features/files/markdown";
import { changeTouchesDiff, changeTouchesFile, changeTouchesFolder, sameRoot } from "./repo-change";
import { useRepoChangeCount, useRepoWatch } from "./repo-watch-store";
import { usePaneStore } from "@/features/panes/pane-store";
import { filesDisabled, useConnectionStore } from "@/features/connection/connection-store";
import { useSettingsStore } from "@/features/settings/settings-store";
import { type RepositoryClient } from "./repository-request";

const CurrentChangesView = lazyComponent(
  () => import("./current-changes-view").then((m) => m.CurrentChangesView),
  <Notice>Loading current changes</Notice>,
);

type Scope = "staged" | "unstaged" | "untracked";
const SCOPE_LABELS: Record<Scope, string> = {
  staged: "Staged",
  unstaged: "Unstaged",
  untracked: "Untracked",
};
type Tab = RepositoryView["tab"];
const TAB_LABELS: Record<Tab, string> = {
  files: "Files",
  changes: "Changes",
  history: "History",
};
const clientIds = new WeakMap<RepositoryClient, number>();
let nextClientId = 0;

function clientKey(client: RepositoryClient) {
  let id = clientIds.get(client);
  if (id === undefined) {
    id = ++nextClientId;
    clientIds.set(client, id);
  }
  return id;
}

export function RepositoryBrowser({
  className,
  onClose,
}: {
  className?: string;
  onClose?: () => void;
}) {
  const client = useRelayClient();
  const paneId = usePaneStore((state) => state.activePaneId);
  const status = useConnectionStore((state) => state.status);
  const capabilities = useConnectionStore((state) => state.capabilities);
  const supported = useConnectionStore((state) => state.features.has("repo:request"));
  const available =
    client && paneId && status === "connected" && supported && !filesDisabled(capabilities);
  return (
    <section
      aria-label="Repository browser"
      // Ctrl with -, = and 0 size the code here. See font-zoom.ts.
      data-zoom-surface="code"
      className={cn(
        "flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-background",
        className,
      )}
    >
      {available ? (
        <BrowserContents
          key={`${clientKey(client)}:${paneId}`}
          client={client}
          paneId={paneId}
          onClose={onClose}
        />
      ) : (
        <>
          <div className="flex h-12 shrink-0 items-center justify-between border-b px-3">
            <h2 className="text-sm">Files</h2>
            {onClose && <CloseButton onClose={onClose} />}
          </div>
          <Notice>
            {filesDisabled(capabilities)
              ? "File access is disabled for this connection."
              : status !== "connected"
                ? "Connect to browse files and current changes."
                : !supported
                  ? "Update tmuxde on this machine to browse files and changes."
                  : "Select a terminal pane to browse its working directory."}
          </Notice>
        </>
      )}
    </section>
  );
}

function CloseButton({ onClose }: { onClose: () => void }) {
  return (
    <Button
      variant="ghost"
      size="icon"
      className="h-11 w-11 shrink-0"
      onClick={onClose}
      aria-label="Close files"
    >
      <X className="h-4 w-4" />
    </Button>
  );
}

function BrowserContents({
  client,
  paneId,
  onClose,
}: {
  client: RepositoryClient;
  paneId: string;
  onClose?: () => void;
}) {
  const { view, navigate, replace, back, forward, canBack, canForward } =
    useRepositoryHistory(paneId);
  const { tab, directory, preview } = view;
  const revealFile = useRef<string | null>(null);
  const commit = view.commit ?? null;
  // A file opened here joins quick open's recent files. Diff previews do not.
  const openedFile = preview && !preview.scope ? preview.path : null;
  useEffect(() => {
    if (openedFile)
      useQuickOpenStore.getState().remember({ machineId: machineId(), path: openedFile });
  }, [openedFile]);
  const historySupported = useConnectionStore((s) => s.features.has("repo:history"));
  const tabs: Tab[] = historySupported ? ["files", "changes", "history"] : ["files", "changes"];
  const [refresh, setRefresh] = useState(0);
  const moves = useFileMoves(client, () => setRefresh((value) => value + 1));
  const [createTarget, setCreateTarget] = useState<CreateTarget | null>(null);
  const canCreate = useConnectionStore(
    (state) =>
      state.status === "connected" &&
      !state.capabilities?.readOnly &&
      (!state.capabilities || state.capabilities.files === "write"),
  );
  const uploaded = useTransferStore((s) => s.revisions[machineId()] ?? 0);
  // Spins from a Refresh click until every answer lands. Quiet reloads after
  // a change on disk never spin.
  const [refreshing, setRefreshing] = useState(false);
  const wrap = useSettingsStore((s) => s.wrapLines);
  const setWrap = useSettingsStore((s) => s.setWrapLines);
  const rendered = useSettingsStore((s) => s.markdownPreview);
  const setRendered = useSettingsStore((s) => s.setMarkdownPreview);
  const id = useId();
  // A `cd` in the pane moves its folder. Asking for the context again then
  // follows it, as the desktop sidebar does.
  const folder = usePaneStore((state) => state.panes.find((p) => p.id === paneId)?.path ?? "");
  const [seenFolder, setSeenFolder] = useState(folder);
  const [folderMoves, setFolderMoves] = useState(0);
  if (folder !== seenFolder) {
    setSeenFolder(folder);
    setFolderMoves((n) => n + 1);
  }
  const contextQuery = useRepositoryQuery(
    client,
    { id: paneId, action: "context" },
    refresh + folderMoves,
    { keepOnRefresh: true },
  );
  const context = contextQuery.result?.kind === "context" ? contextQuery.result : undefined;
  useEffect(() => {
    if (context && directory === null) {
      replace({ ...view, directory: context.path });
    }
  }, [context, directory, view, replace]);
  // The listing follows a new pane folder unless someone browsed away.
  const lastContextPath = useRef(context?.path);
  useEffect(() => {
    const before = lastContextPath.current;
    lastContextPath.current = context?.path;
    if (!context || !before || before === context.path) return;
    if (directory === before) replace({ ...view, directory: context.path });
  }, [context, directory, view, replace]);
  // The server watch of the repository, and quiet reloads on its pushes.
  const root = context?.root ?? undefined;
  useRepoWatch(client, root, { paneId, path: context?.path });
  const path = directory ?? context?.path;
  const listingPushes = useRepoChangeCount((change) =>
    path ? changeTouchesFolder(change, path) : false,
  );
  const statusPushes = useRepoChangeCount((change) => (root ? sameRoot(change, root) : false));
  const previewRoot = preview?.root ?? root;
  useRepoWatch(client, preview?.scope && previewRoot !== root ? previewRoot : null, {
    paneId,
    path: previewRoot,
  });
  const previewPushes = useRepoChangeCount((change) =>
    !preview
      ? false
      : preview.scope
        ? !!previewRoot &&
          changeTouchesDiff(change, previewRoot, preview.path, preview.scope !== "untracked")
        : changeTouchesFile(change, preview.path),
  );
  const listing = useRepositoryQuery(
    client,
    context && path && !preview && !commit && tab === "files"
      ? { id: paneId, action: "list", path }
      : null,
    refresh + listingPushes + uploaded,
    { keepOnRefresh: true },
  );
  const statusQuery = useRepositoryQuery(
    client,
    context ? { id: paneId, action: "status", path: context.path } : null,
    refresh + statusPushes,
    { keepOnRefresh: true },
  );
  const status = statusQuery.result?.kind === "status" ? statusQuery.result : undefined;
  const workspace = useWorkspaceChanges(
    client,
    paneId,
    context,
    status,
    refresh,
    tab === "changes" || tab === "history",
  );
  const fileQuery = useRepositoryQuery(
    client,
    preview && context
      ? preview.scope
        ? {
            id: paneId,
            action: "diff",
            path: preview.root ?? context.path,
            file: preview.path,
            scope: preview.scope,
          }
        : { id: paneId, action: "read", path: preview.path }
      : null,
    refresh + previewPushes,
    { keepOnRefresh: true },
  );
  const content =
    fileQuery.result?.kind === "read" || fileQuery.result?.kind === "diff"
      ? fileQuery.result
      : undefined;
  const commitQuery = useRepositoryQuery(
    client,
    commit && context && historySupported
      ? { id: paneId, action: "show", path: commit.root ?? context.path, commit: commit.hash }
      : null,
    refresh,
  );
  const commitResult = commitQuery.result?.kind === "show" ? commitQuery.result : undefined;
  // A query with nothing to show yet. Reloads keep their last answer.
  const empty = (query: { loading: boolean; result?: unknown; error?: string }) =>
    query.loading && !query.result && !query.error;
  const anyLoading =
    contextQuery.loading ||
    listing.loading ||
    statusQuery.loading ||
    fileQuery.loading ||
    commitQuery.loading;
  // Every answer landed. Cleared during render, so the spinner stops in the
  // same paint as the last answer.
  if (refreshing && !anyLoading) setRefreshing(false);
  const spinning =
    refreshing ||
    empty(contextQuery) ||
    empty(listing) ||
    empty(statusQuery) ||
    empty(fileQuery) ||
    empty(commitQuery);
  const openCommit = (
    hash: string,
    subject: string,
    commitRoot = commit?.root ?? context?.root ?? undefined,
  ) => navigate({ ...view, preview: null, commit: { hash, subject, root: commitRoot } });
  const entries = listing.result?.kind === "list" ? listing.result.entries : [];
  const go = (nextPath: string) => {
    navigate({ ...view, directory: nextPath, filter: "", preview: null });
  };
  const previewPath =
    preview?.scope && previewRoot
      ? `${previewRoot.replace(/\/$/, "")}/${preview.path}`
      : preview?.path;
  const markdown = !!preview && !preview.scope && isMarkdownPath(preview.path);
  const showRendered = markdown && rendered;
  const tabButton = (value: Tab) => (
    <button
      key={value}
      type="button"
      role="tab"
      id={`${id}-${value}`}
      aria-controls={`${id}-panel`}
      aria-selected={tab === value}
      tabIndex={tab === value ? 0 : -1}
      onKeyDown={(event) => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const index = tabs.indexOf(value);
        const next =
          event.key === "Home"
            ? tabs[0]!
            : event.key === "End"
              ? tabs[tabs.length - 1]!
              : tabs[(index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length]!;
        navigate({ ...view, tab: next, preview: null, commit: null, changesPath: null });
        document.getElementById(`${id}-${next}`)?.focus();
      }}
      onClick={() => {
        navigate({ ...view, tab: value, preview: null, commit: null, changesPath: null });
      }}
      className={cn(
        "flex min-h-12 items-center gap-2 border-b-2 px-4 text-sm font-medium",
        tab === value
          ? "border-primary text-foreground"
          : "border-transparent text-muted-foreground hover:text-foreground",
      )}
    >
      {TAB_LABELS[value]}
      {value === "changes" && workspace.count ? (
        <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] tabular-nums">
          {workspace.count}
          {workspace.truncated ? "+" : ""}
        </span>
      ) : null}
    </button>
  );
  return (
    <RepositoryNavigationSurface back={back} forward={forward}>
      {moves.selection && <FileMoveDialog moves={moves} />}
      {createTarget && (
        <FileCreateDialog
          target={createTarget}
          onClose={() => setCreateTarget(null)}
          onCreated={(createdPath) => {
            setRefresh((value) => value + 1);
            setCreateTarget(null);
            if (createTarget.kind === "folder") go(createdPath);
            else useFileStore.getState().openEditor(createdPath);
          }}
        />
      )}
      <div className="flex shrink-0 items-center justify-between gap-1 border-b px-1">
        <div role="tablist" aria-label="Repository views" className="flex">
          {tabs.map(tabButton)}
        </div>
        <div className="flex items-center">
          <Button
            variant="ghost"
            size="icon"
            className="h-11 w-11"
            onClick={back}
            disabled={!canBack}
            aria-label="Go back"
            title="Go back"
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-11 w-11"
            onClick={forward}
            disabled={!canForward}
            aria-label="Go forward"
            title="Go forward"
          >
            <ArrowRight className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-11 w-11"
            onClick={() => {
              setRefresh((value) => value + 1);
              setRefreshing(true);
            }}
            aria-label="Refresh"
            title="Refresh"
          >
            <RefreshCw
              className={cn("h-4 w-4", spinning && "animate-spin motion-reduce:animate-none")}
            />
          </Button>
          {onClose && <CloseButton onClose={onClose} />}
        </div>
      </div>
      <div
        id={`${id}-panel`}
        role="tabpanel"
        aria-labelledby={`${id}-${tab}`}
        className="flex min-h-0 min-w-0 flex-1 flex-col"
      >
        {contextQuery.error ? (
          <Notice error>{contextQuery.error}</Notice>
        ) : empty(contextQuery) ? (
          <Notice>Finding pane directory...</Notice>
        ) : !context ? (
          <Notice>Pane directory unavailable. Refresh to try again.</Notice>
        ) : (
          <>
            {preview ? (
              <>
                <div className="flex shrink-0 items-center gap-1 border-b px-2">
                  <Button
                    variant="ghost"
                    className="h-11 shrink-0 gap-1 px-2"
                    onClick={() => (canBack ? back() : navigate({ ...view, preview: null }))}
                  >
                    <ArrowLeft className="h-4 w-4" />
                    Back
                  </Button>
                  <RepositoryFileIcon path={preview.path} />
                  <span
                    className="min-w-0 flex-1 truncate text-sm font-medium"
                    title={preview.path}
                  >
                    {preview.path.split("/").pop()}
                  </span>
                  {!preview.scope && <DownloadButton path={preview.path} />}
                  {markdown && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-11 w-11 aria-pressed:bg-accent aria-pressed:text-foreground"
                      aria-label="Render Markdown"
                      aria-pressed={rendered}
                      title="Render Markdown"
                      onClick={() => setRendered(!rendered)}
                    >
                      <BookOpen className={cn("h-4 w-4", rendered && "text-primary")} />
                    </Button>
                  )}
                  {!showRendered && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-11 w-11 aria-pressed:bg-accent aria-pressed:text-foreground"
                      aria-label="Wrap lines"
                      aria-pressed={wrap}
                      title="Wrap lines"
                      onClick={() => setWrap(!wrap)}
                    >
                      <WrapText className={cn("h-4 w-4", wrap && "text-primary")} />
                    </Button>
                  )}
                </div>
                <div className="shrink-0 border-b bg-muted/30 px-3 py-2">
                  <p className="break-all font-mono text-code-meta leading-relaxed text-muted-foreground">
                    {previewPath}
                  </p>
                  {preview.scope && (
                    <p className="mt-1 text-xs font-medium">
                      {SCOPE_LABELS[preview.scope]} changes
                    </p>
                  )}
                </div>
                {fileQuery.error ? (
                  <Notice error>{fileQuery.error}</Notice>
                ) : empty(fileQuery) ? (
                  <Notice>Loading preview...</Notice>
                ) : content ? (
                  <FilePreview
                    result={content}
                    path={previewPath ?? preview.path}
                    wrap={wrap}
                    size={preview.size}
                    symlink={preview.symlink}
                    rendered={showRendered}
                    onOpenPath={(target) => navigate({ ...view, preview: { path: target } })}
                  />
                ) : null}
              </>
            ) : view.changesPath ? (
              <CurrentChangesView
                key={view.changesPath}
                client={client}
                paneId={paneId}
                path={view.changesPath}
                touch
                onBack={() => (canBack ? back() : navigate({ ...view, changesPath: null }))}
              />
            ) : commit ? (
              <>
                <div className="flex shrink-0 items-center gap-1 border-b px-2">
                  <Button
                    variant="ghost"
                    className="h-11 shrink-0 gap-1 px-2"
                    onClick={() =>
                      canBack ? back() : navigate({ ...view, commit: null, changesPath: null })
                    }
                  >
                    <ArrowLeft className="h-4 w-4" />
                    Back
                  </Button>
                  <GitCommitHorizontal
                    className="h-4 w-4 shrink-0 text-muted-foreground"
                    aria-hidden
                  />
                  <span
                    className="min-w-0 flex-1 truncate text-sm font-medium"
                    title={commit.subject || commitResult?.commit.subject}
                  >
                    {commit.subject || commitResult?.commit.subject || commit.hash.slice(0, 7)}
                  </span>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-11 w-11"
                    aria-label="Wrap lines"
                    aria-pressed={wrap}
                    title="Wrap lines"
                    onClick={() => setWrap(!wrap)}
                  >
                    <WrapText className={cn("h-4 w-4", wrap && "text-primary")} />
                  </Button>
                </div>
                {!historySupported ? (
                  <Notice>Update tmuxde on this machine to browse history.</Notice>
                ) : commitQuery.error ? (
                  <Notice error>{commitQuery.error}</Notice>
                ) : commitQuery.loading || !commitResult ? (
                  <Notice>Loading commit...</Notice>
                ) : (
                  <CommitDetail
                    key={commitResult.commit.hash}
                    touch
                    result={commitResult}
                    wrap={wrap}
                    onOpenCommit={(hash) => openCommit(hash, "")}
                  />
                )}
              </>
            ) : tab === "files" ? (
              <>
                <div className="flex items-center border-b">
                  <div className="min-w-0 flex-1">
                    <Breadcrumbs path={path ?? context.path} go={go} moves={moves} />
                  </div>
                  {(["file", "folder"] as const).map((kind) => {
                    const Icon = kind === "file" ? FilePlus : FolderPlus;
                    return (
                      <Button
                        key={kind}
                        variant="ghost"
                        size="icon"
                        className="h-11 w-11 shrink-0"
                        aria-label={`New ${kind}`}
                        title={`New ${kind}`}
                        disabled={!canCreate}
                        onClick={() =>
                          setCreateTarget({
                            kind,
                            directory: path ?? context.path,
                            machine: machineId(),
                            paneId,
                            client,
                          })
                        }
                      >
                        <Icon className="h-4 w-4" aria-hidden />
                      </Button>
                    );
                  })}
                  <UploadControl directory={path ?? context.path} />
                </div>
                <div className="min-h-0 flex-1 overflow-auto">
                  {listing.error ? (
                    <Notice error>{listing.error}</Notice>
                  ) : empty(listing) ? (
                    <Notice>Loading files...</Notice>
                  ) : entries.length ? (
                    <ul className="py-1">
                      {entries.map((entry) => (
                        <FileRow
                          key={entry.path}
                          entry={entry}
                          buttonRef={(button) => {
                            if (button && revealFile.current === entry.path) {
                              revealFile.current = null;
                              button.focus();
                            }
                          }}
                          moves={moves}
                          onOpen={() =>
                            entry.type === "directory"
                              ? go(entry.path)
                              : navigate({
                                  ...view,
                                  preview: {
                                    path: entry.path,
                                    size: entry.type === "file" ? entry.size : undefined,
                                    symlink: entry.type === "symlink",
                                  },
                                })
                          }
                        />
                      ))}
                    </ul>
                  ) : (
                    <Notice>This folder is empty.</Notice>
                  )}
                  {listing.result?.kind === "list" && listing.result.truncated && (
                    <Notice>Folder listing shortened. Some entries are not shown.</Notice>
                  )}
                </div>
                <div className="flex shrink-0 items-center justify-between gap-2 border-t px-3 py-2 text-[11px] text-muted-foreground">
                  <span>
                    {entries.length} {entries.length === 1 ? "entry" : "entries"}
                  </span>
                </div>
              </>
            ) : tab === "changes" ? (
              <div className="min-h-0 flex-1 overflow-auto">
                <GroupedChanges
                  context={context}
                  client={client}
                  paneId={paneId}
                  workspace={workspace}
                  parentError={statusQuery.error}
                  onReveal={(file) => {
                    revealFile.current = file;
                    navigate({ tab: "files", directory: dirname(file), filter: "", preview: null });
                  }}
                  onOpen={(repoRoot, file, scope) =>
                    navigate({ ...view, preview: { root: repoRoot, path: file, scope } })
                  }
                  onOpenAll={(repoRoot) => navigate({ ...view, changesPath: repoRoot })}
                />
              </div>
            ) : (
              <div className="min-h-0 flex-1 overflow-auto">
                {historySupported ? (
                  <GroupedHistory
                    workspace={workspace}
                    context={context}
                    paneId={paneId}
                    client={client}
                    refresh={refresh}
                    tick={statusQuery.result}
                    onOpen={(commitRoot, item) => openCommit(item.hash, item.subject, commitRoot)}
                  />
                ) : (
                  <Notice>Update tmuxde on this machine to browse history.</Notice>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </RepositoryNavigationSurface>
  );
}

function Breadcrumbs({
  path,
  go,
  moves,
}: {
  path: string;
  go: (path: string) => void;
  moves: ReturnType<typeof useFileMoves>;
}) {
  const parts = path.split("/").filter(Boolean);
  const scrollRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollLeft = scrollRef.current.scrollWidth;
  }, [path]);
  return (
    <nav
      ref={scrollRef}
      aria-label="File path"
      className="flex min-h-11 shrink-0 items-center overflow-x-auto border-b px-2 text-xs scrollbar-none"
    >
      <button
        type="button"
        {...moves.dropProps("/")}
        onClick={() => go("/")}
        className="min-h-11 shrink-0 px-2 font-mono hover:text-primary"
        aria-label="Filesystem root"
      >
        /
      </button>
      {parts.map((part, index) => {
        const target = `/${parts.slice(0, index + 1).join("/")}`;
        return (
          <span key={target} className="flex shrink-0 items-center">
            <ChevronRight aria-hidden className="h-3 w-3 text-muted-foreground" />
            <button
              type="button"
              aria-current={index === parts.length - 1 ? "location" : undefined}
              title={target}
              {...moves.dropProps(target)}
              onClick={() => go(target)}
              className={cn(
                "min-h-11 max-w-48 truncate px-2 font-mono hover:text-primary",
                moves.over === target &&
                  "bg-primary/15 outline outline-1 -outline-offset-1 outline-primary",
              )}
            >
              {part}
            </button>
          </span>
        );
      })}
    </nav>
  );
}

function FileRow({
  entry,
  buttonRef,
  onOpen,
  moves,
}: {
  entry: FileEntry;
  buttonRef: (button: HTMLButtonElement | null) => void;
  onOpen: () => void;
  moves: ReturnType<typeof useFileMoves>;
}) {
  const isDirectory = entry.type === "directory";
  return (
    <li
      {...moves.dragProps(entry)}
      {...moves.dropProps(isDirectory ? entry.path : null)}
      className={cn(
        "flex items-center",
        moves.over === entry.path &&
          "bg-primary/15 outline outline-1 -outline-offset-1 outline-primary",
      )}
    >
      <button
        type="button"
        ref={buttonRef}
        onClick={onOpen}
        title={entry.path}
        className="flex min-h-11 min-w-0 flex-1 items-center gap-3 px-4 py-2 text-left hover:bg-muted/60 focus-visible:bg-muted"
      >
        <RepositoryFileIcon path={entry.path} type={entry.type} repository={entry.repository} />
        <span className="min-w-0 flex-1 truncate text-sm">{entry.name}</span>
        {isDirectory ? (
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
            {entry.type === "symlink" ? "Link" : formatFileSize(entry.size)}
          </span>
        )}
      </button>
      {moves.allowed && (
        <Button
          variant="ghost"
          size="icon"
          className="h-11 w-11 shrink-0"
          aria-label={`Move ${entry.name}`}
          onClick={() => moves.setSelection(entry)}
        >
          <FolderInput className="h-4 w-4" aria-hidden />
        </Button>
      )}
      {entry.type === "file" && <DownloadButton path={entry.path} />}
    </li>
  );
}
