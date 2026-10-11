"use client";

import { useEffect, useId, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  ChevronRight,
  GitBranch,
  GitCompareArrows,
  RefreshCw,
  Search,
  WrapText,
  X,
} from "lucide-react";
import type { FileEntry } from "@repo/protocol";
import { cn } from "@repo/ui/lib/utils";
import { Button } from "@repo/ui/components/ui/button";
import { useRelayClient } from "@/hooks/use-websocket";
import { useRepositoryHistory } from "./repository-history";
import { RepositoryNavigationSurface } from "./repository-navigation-surface";
import { ChangesList } from "./repository-changes";
import { RepositoryFileIcon } from "./repository-file-icon";
import { FilePreview, Notice, useRepositoryQuery } from "./repository-preview";
import { formatFileSize } from "@/lib/file-utils";
import { usePaneStore } from "@/stores/pane-store";
import { filesDisabled, useConnectionStore } from "@/stores/connection-store";
import { type RepositoryClient } from "./repository-request";

type Scope = "staged" | "unstaged" | "untracked";
const SCOPE_LABELS: Record<Scope, string> = {
  staged: "Staged",
  unstaged: "Unstaged",
  untracked: "Untracked",
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
  const supported = useConnectionStore((state) =>
    state.features.has("repo:request"),
  );
  const available =
    client &&
    paneId &&
    status === "connected" &&
    supported &&
    !filesDisabled(capabilities);
  return (
    <section
      aria-label="Repository browser"
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
                  ? "Update mtmux on this machine to browse files and changes."
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
  const [refresh, setRefresh] = useState(0);
  const [wrap, setWrap] = useState(false);
  const id = useId();
  const contextQuery = useRepositoryQuery(
    client,
    { id: paneId, action: "context" },
    refresh,
  );
  const context =
    contextQuery.result?.kind === "context" ? contextQuery.result : undefined;
  useEffect(() => {
    if (context && directory === null) {
      replace({ ...view, directory: context.path });
    }
  }, [context, directory, view, replace]);
  const path = directory ?? context?.path;
  const listing = useRepositoryQuery(
    client,
    context && path && !preview && tab === "files"
      ? { id: paneId, action: "list", path }
      : null,
    refresh,
  );
  const statusQuery = useRepositoryQuery(
    client,
    context ? { id: paneId, action: "status", path: context.path } : null,
    refresh,
  );
  const status =
    statusQuery.result?.kind === "status" ? statusQuery.result : undefined;
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
    refresh,
  );
  const content =
    fileQuery.result?.kind === "read" || fileQuery.result?.kind === "diff"
      ? fileQuery.result
      : undefined;
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
  const tabButton = (value: "files" | "changes", label: string) => (
    <button
      type="button"
      role="tab"
      id={`${id}-${value}`}
      aria-controls={`${id}-panel`}
      aria-selected={tab === value}
      tabIndex={tab === value ? 0 : -1}
      onKeyDown={(event) => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key))
          return;
        event.preventDefault();
        const next =
          event.key === "Home"
            ? "files"
            : event.key === "End"
              ? "changes"
              : value === "files"
                ? "changes"
                : "files";
        navigate({ ...view, tab: next, preview: null });
        document.getElementById(`${id}-${next}`)?.focus();
      }}
      onClick={() => {
        navigate({ ...view, tab: value, preview: null });
      }}
      className={cn(
        "flex min-h-12 items-center gap-2 border-b-2 px-4 text-sm font-medium",
        tab === value
          ? "border-primary text-foreground"
          : "border-transparent text-muted-foreground hover:text-foreground",
      )}
    >
      {label}
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
          {tabButton("files", "Files")}
          {tabButton("changes", "Changes")}
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
            onClick={() => setRefresh((value) => value + 1)}
            aria-label="Refresh files and changes"
            title="Refresh files and changes"
          >
            <RefreshCw
              className={cn(
                "h-4 w-4",
                (contextQuery.loading ||
                  listing.loading ||
                  statusQuery.loading ||
                  fileQuery.loading) &&
                  "animate-spin motion-reduce:animate-none",
              )}
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
        ) : contextQuery.loading ? (
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
                    onClick={() =>
                      canBack ? back() : navigate({ ...view, preview: null })
                    }
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
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-11 w-11"
                    aria-label="Wrap lines"
                    aria-pressed={wrap}
                    title="Wrap lines"
                    onClick={() => setWrap((value) => !value)}
                  >
                    <WrapText
                      className={cn("h-4 w-4", wrap && "text-primary")}
                    />
                  </Button>
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
                ) : fileQuery.loading ? (
                  <Notice>Loading preview...</Notice>
                ) : content ? (
                  <FilePreview
                    result={content}
                    path={previewPath ?? preview.path}
                    wrap={wrap}
                    size={preview.size}
                  />
                ) : null}
              </>
            ) : tab === "files" ? (
              <>
                <Breadcrumbs path={path ?? context.path} go={go} />
                <div className="shrink-0 border-b px-3 py-2">
                  <label className="flex min-h-10 items-center gap-2 rounded-md border border-input bg-background px-2.5 focus-within:ring-1 focus-within:ring-ring">
                    <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <input
                      aria-label="Filter files in this folder"
                      placeholder="Filter this folder"
                      value={filter}
                      onChange={(event) =>
                        replace({ ...view, filter: event.target.value })
                      }
                      className="min-w-0 flex-1 bg-transparent py-2 text-sm outline-none placeholder:text-muted-foreground"
                    />
                  </label>
                </div>
                <div className="min-h-0 flex-1 overflow-auto">
                  {listing.error ? (
                    <Notice error>{listing.error}</Notice>
                  ) : listing.loading ? (
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
                                    size:
                                      entry.type === "file"
                                        ? entry.size
                                        : undefined,
                                  },
                                })
                          }
                        />
                      ))}
                    </ul>
                  ) : (
                    <Notice>
                      {filter
                        ? "No files match this filter."
                        : "This folder is empty."}
                    </Notice>
                  )}
                  {listing.result?.kind === "list" &&
                    listing.result.truncated && (
                      <Notice>
                        Folder listing shortened. Some entries are not shown.
                      </Notice>
                    )}
                </div>
                <div className="flex shrink-0 items-center justify-between gap-2 border-t px-3 py-2 text-[11px] text-muted-foreground">
                  <span>
                    {filtered.length}{" "}
                    {filtered.length === 1 ? "entry" : "entries"}
                  </span>
                  <span>Read only</span>
                </div>
              </>
            ) : (
              <>
                <div className="shrink-0 border-b px-3 py-3">
                  <div className="flex items-center gap-2 text-sm">
                    <GitBranch className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <span
                      className="truncate"
                      title={status?.branch ?? context.branch ?? undefined}
                    >
                      {status?.branch ??
                        context.branch ??
                        (context.root ? "Detached HEAD" : "No repository")}
                    </span>
                  </div>
                  {context.root && (
                    <p className="mt-1 break-all font-mono text-code-meta text-muted-foreground">
                      {context.root}
                    </p>
                  )}
                </div>
                <div className="min-h-0 flex-1 overflow-auto">
                  {statusQuery.error ? (
                    <Notice error>{statusQuery.error}</Notice>
                  ) : statusQuery.loading ? (
                    <Notice>Loading current changes...</Notice>
                  ) : !status?.root ? (
                    <Notice>
                      Pane directory is outside a Git repository. Use Files to
                      browse this folder.
                    </Notice>
                  ) : status.entries.length === 0 ? (
                    <div className="px-4 py-8">
                      <GitCompareArrows className="mb-3 h-5 w-5 text-muted-foreground" />
                      <p className="text-sm font-medium">
                        Working tree is clean
                      </p>
                      <p className="mt-1 text-sm text-muted-foreground">
                        No staged, unstaged, or untracked files.
                      </p>
                    </div>
                  ) : (
                    <ChangesList
                      entries={status.entries}
                      onOpen={(path, scope) =>
                        navigate({ ...view, preview: { path, scope } })
                      }
                    />
                  )}
                  {status?.truncated && (
                    <Notice>
                      Change list shortened. Some files are not shown.
                    </Notice>
                  )}
                </div>
                <div className="shrink-0 border-t px-3 py-2 text-[11px] text-muted-foreground">
                  Current working tree · Read only
                </div>
              </>
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
}: {
  path: string;
  go: (path: string) => void;
}) {
  const parts = path.split("/").filter(Boolean);
  const scrollRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (scrollRef.current)
      scrollRef.current.scrollLeft = scrollRef.current.scrollWidth;
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
            <ChevronRight
              aria-hidden
              className="h-3 w-3 text-muted-foreground"
            />
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
    <li>
      <button
        type="button"
        onClick={onOpen}
        title={entry.path}
        className="flex min-h-11 w-full items-center gap-3 px-4 py-2 text-left hover:bg-muted/60 focus-visible:bg-muted"
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
    </li>
  );
}
