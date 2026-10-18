import { QuickOpenTrigger } from "./quick-open-trigger";
import { useQuickOpenStore } from "@/stores/quick-open-store";
import { useEffect, useId, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  ChevronRight,
  GitBranch,
  GitCommitHorizontal,
  GitCompareArrows,
  History,
  RefreshCw,
  Search,
  WrapText,
  X,
} from "lucide-react";
import { DownloadButton, UploadControl } from "./transfer-controls";
import { useTransferStore } from "@/stores/transfer-store";
import { machineId } from "@/lib/machine-context";
import type { FileEntry } from "@/protocol";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { useRelayClient } from "@/hooks/use-websocket";
import { CommitList } from "./commit-log";
import { useCommitLog } from "./use-commit-log";
import { lazyComponent } from "@/lib/lazy-component";
import { CommitDetail } from "./commit-view";
import { useRepositoryHistory, type RepositoryView } from "./repository-history";
import { RepositoryNavigationSurface } from "./repository-navigation-surface";
import { ChangesList } from "./repository-changes";
import { RepositoryFileIcon } from "./repository-file-icon";
import { FilePreview, Notice } from "./repository-preview";
import { useRepositoryQuery } from "./use-repository-query";
import { formatFileSize } from "@/lib/file-utils";
import { isMarkdownPath } from "@/lib/markdown";
import {
  changeTouchesDiff,
  changeTouchesFile,
  changeTouchesFolder,
  sameRoot,
} from "@/lib/repo-change";
import { useRepoChangeCount, useRepoWatch } from "@/stores/repo-watch-store";
import { usePaneStore } from "@/stores/pane-store";
import { filesDisabled, useConnectionStore } from "@/stores/connection-store";
import { useSettingsStore } from "@/stores/settings-store";
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
  const { tab, directory, filter, preview } = view;
  const commit = view.commit ?? null;
  useEffect(() => {
    if (preview && !preview.scope)
      useQuickOpenStore.getState().remember({ machineId: machineId(), path: preview.path });
  }, [preview?.path, preview?.scope]);
  const historySupported = useConnectionStore((s) => s.features.has("repo:history"));
  const tabs: Tab[] = historySupported ? ["files", "changes", "history"] : ["files", "changes"];
  const [refresh, setRefresh] = useState(0);
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
  const previewPushes = useRepoChangeCount((change) =>
    !preview
      ? false
      : preview.scope
        ? !!root && changeTouchesDiff(change, root, preview.path, preview.scope !== "untracked")
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
  const fileQuery = useRepositoryQuery(
    client,
    preview && context
      ? preview.scope
        ? {
            id: paneId,
            action: "diff",
            path: context.path,
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
  const log = useCommitLog({
    client: historySupported ? client : null,
    paneId,
    path: context?.path,
    // Asks nothing until History is open.
    root: tab === "history" ? context?.root : undefined,
    refresh,
    tick: statusQuery.result,
  });
  const commitQuery = useRepositoryQuery(
    client,
    commit && context && historySupported
      ? { id: paneId, action: "show", path: context.path, commit: commit.hash }
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
    commitQuery.loading ||
    log.refreshing;
  useEffect(() => {
    if (refreshing && !anyLoading) setRefreshing(false);
  }, [refreshing, anyLoading]);
  const spinning =
    refreshing ||
    empty(contextQuery) ||
    empty(listing) ||
    empty(statusQuery) ||
    empty(fileQuery) ||
    empty(commitQuery);
  const openCommit = (hash: string, subject: string) =>
    navigate({ ...view, preview: null, commit: { hash, subject } });
  const entries = listing.result?.kind === "list" ? listing.result.entries : [];
  const filtered = entries.filter((entry) =>
    entry.name.toLocaleLowerCase().includes(filter.toLocaleLowerCase()),
  );
  const go = (nextPath: string) => {
    navigate({ ...view, directory: nextPath, filter: "", preview: null });
  };
  const previewPath =
    preview?.scope && context?.root
      ? `${context.root.replace(/\/$/, "")}/${preview.path}`
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
      {value === "changes" && status?.entries.length ? (
        <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] tabular-nums">
          {status.entries.length}
          {status.truncated ? "+" : ""}
        </span>
      ) : null}
    </button>
  );
  return (
    <RepositoryNavigationSurface back={back} forward={forward}>
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
      {tab === "files" && <QuickOpenTrigger />}
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
                    <Breadcrumbs path={path ?? context.path} go={go} />
                  </div>
                  <UploadControl directory={path ?? context.path} />
                </div>
                <div className="shrink-0 border-b px-3 py-2">
                  <label className="flex min-h-10 items-center gap-2 rounded-md border border-input bg-background px-2.5 focus-within:ring-1 focus-within:ring-ring">
                    <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <input
                      aria-label="Filter files in this folder"
                      placeholder="Filter this folder"
                      value={filter}
                      onChange={(event) => replace({ ...view, filter: event.target.value })}
                      className="min-w-0 flex-1 bg-transparent py-2 text-sm outline-none placeholder:text-muted-foreground"
                    />
                  </label>
                </div>
                <div className="min-h-0 flex-1 overflow-auto">
                  {listing.error ? (
                    <Notice error>{listing.error}</Notice>
                  ) : empty(listing) ? (
                    <Notice>Loading files...</Notice>
                  ) : filtered.length ? (
                    <ul className="py-1">
                      {filtered.map((entry) => (
                        <FileRow
                          key={entry.path}
                          entry={entry}
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
                    <Notice>
                      {filter ? "No files match this filter." : "This folder is empty."}
                    </Notice>
                  )}
                  {listing.result?.kind === "list" && listing.result.truncated && (
                    <Notice>Folder listing shortened. Some entries are not shown.</Notice>
                  )}
                </div>
                <div className="flex shrink-0 items-center justify-between gap-2 border-t px-3 py-2 text-[11px] text-muted-foreground">
                  <span>
                    {filtered.length} {filtered.length === 1 ? "entry" : "entries"}
                  </span>
                </div>
              </>
            ) : tab === "changes" ? (
              <>
                <BranchBlock branch={status?.branch ?? context.branch} root={context.root} />
                {status?.root && status.entries.length > 0 && (
                  <div className="shrink-0 border-b px-3 py-2">
                    <Button
                      variant="outline"
                      className="min-h-11 w-full gap-2"
                      onClick={() => navigate({ ...view, changesPath: status.root })}
                    >
                      <GitCompareArrows className="h-4 w-4" aria-hidden />
                      View all changes
                    </Button>
                  </div>
                )}
                <div className="min-h-0 flex-1 overflow-auto">
                  {statusQuery.error ? (
                    <Notice error>{statusQuery.error}</Notice>
                  ) : empty(statusQuery) ? (
                    <Notice>Loading current changes...</Notice>
                  ) : !status?.root ? (
                    <Notice>
                      Pane directory is outside a Git repository. Use Files to browse this folder.
                    </Notice>
                  ) : status.entries.length === 0 ? (
                    <div className="px-4 py-8">
                      <GitCompareArrows className="mb-3 h-5 w-5 text-muted-foreground" />
                      <p className="text-sm font-medium">Working tree is clean</p>
                      <p className="mt-1 text-sm text-muted-foreground">
                        No staged, unstaged, or untracked files.
                      </p>
                    </div>
                  ) : (
                    <ChangesList
                      entries={status.entries}
                      onOpen={(file, scope) =>
                        navigate({ ...view, preview: { path: file, scope } })
                      }
                    />
                  )}
                  {status?.truncated && (
                    <Notice>Change list shortened. Some files are not shown.</Notice>
                  )}
                </div>
                <div className="shrink-0 border-t px-3 py-2 text-[11px] text-muted-foreground">
                  Current working tree · Read only
                </div>
              </>
            ) : (
              <>
                <BranchBlock branch={status?.branch ?? context.branch} root={context.root} />
                <div className="min-h-0 flex-1 overflow-auto">
                  {!historySupported ? (
                    <Notice>Update tmuxde on this machine to browse history.</Notice>
                  ) : !context.root ? (
                    <Notice>
                      Pane directory is outside a Git repository. Use Files to browse this folder.
                    </Notice>
                  ) : log.loading ? (
                    <Notice>Loading history...</Notice>
                  ) : log.commits.length === 0 && log.error ? (
                    <Notice error>{log.error}</Notice>
                  ) : log.commits.length === 0 ? (
                    <div className="px-4 py-8">
                      <History className="mb-3 h-5 w-5 text-muted-foreground" />
                      <p className="text-sm font-medium">No commits yet</p>
                      <p className="mt-1 text-sm text-muted-foreground">
                        Commits on this branch show here after the first one.
                      </p>
                    </div>
                  ) : (
                    <>
                      <CommitList
                        commits={log.commits}
                        onOpen={(item) => openCommit(item.hash, item.subject)}
                      />
                      {log.error && <Notice error>{log.error}</Notice>}
                      {log.more && (
                        <div className="px-4 pt-1 pb-4">
                          <Button
                            variant="outline"
                            className="h-11 w-full gap-2"
                            disabled={log.loadingMore}
                            onClick={log.loadMore}
                          >
                            {log.loadingMore && (
                              <RefreshCw
                                className="h-4 w-4 animate-spin motion-reduce:animate-none"
                                aria-hidden
                              />
                            )}
                            Load older commits
                          </Button>
                        </div>
                      )}
                    </>
                  )}
                </div>
                <div className="shrink-0 border-t px-3 py-2 text-[11px] text-muted-foreground">
                  History of HEAD · Read only
                </div>
              </>
            )}
          </>
        )}
      </div>
    </RepositoryNavigationSurface>
  );
}

function BranchBlock({ branch, root }: { branch: string | null; root: string | null }) {
  return (
    <div className="shrink-0 border-b px-3 py-3">
      <div className="flex items-center gap-2 text-sm">
        <GitBranch className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="truncate" title={branch ?? undefined}>
          {branch ?? (root ? "Detached HEAD" : "No repository")}
        </span>
      </div>
      {root && (
        <p className="mt-1 break-all font-mono text-code-meta text-muted-foreground">{root}</p>
      )}
    </div>
  );
}

function Breadcrumbs({ path, go }: { path: string; go: (path: string) => void }) {
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
              onClick={() => go(target)}
              className="min-h-11 max-w-48 truncate px-2 font-mono hover:text-primary"
            >
              {part}
            </button>
          </span>
        );
      })}
    </nav>
  );
}

function FileRow({ entry, onOpen }: { entry: FileEntry; onOpen: () => void }) {
  const isDirectory = entry.type === "directory";
  return (
    <li className="flex items-center">
      <button
        type="button"
        onClick={onOpen}
        title={entry.path}
        className="flex min-h-11 min-w-0 flex-1 items-center gap-3 px-4 py-2 text-left hover:bg-muted/60 focus-visible:bg-muted"
      >
        <RepositoryFileIcon path={entry.path} type={entry.type} />
        <span className="min-w-0 flex-1 truncate text-sm">{entry.name}</span>
        {isDirectory ? (
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
            {entry.type === "symlink" ? "Link" : formatFileSize(entry.size)}
          </span>
        )}
      </button>
      {entry.type === "file" && <DownloadButton path={entry.path} />}
    </li>
  );
}
