"use client";

import { useEffect, useState } from "react";
import type { RepoResult } from "@repo/protocol";
import { cn } from "@repo/ui/lib/utils";
import { useFileObjectUrl } from "@/hooks/use-file-object-url";
import { RepositorySyntaxLine, useRepositorySyntax } from "./repository-syntax";
import { filesAvailable } from "@/lib/file-url";
import { getFileCategory } from "@/lib/file-utils";
import { useSessionTreeStore } from "@/stores/session-tree-store";
import {
  repositoryRequest,
  type RepositoryClient,
  type RepositoryQuery,
} from "./repository-request";

/**
 * Repository queries and the file preview, shared by the mobile repository
 * browser, the desktop sidebar and desktop file tabs.
 */
export type RepositoryResult = Exclude<RepoResult, { kind: "error" }>;
type Result = RepositoryResult;

/**
 * `keepPrevious` leaves the last answer on screen while the next one loads.
 * Only for callers whose query names the same thing across changes, such as
 * one folder of the sidebar tree asked again for another pane.
 */
export function useRepositoryQuery(
  client: RepositoryClient,
  query: RepositoryQuery | null,
  refresh: number,
  { keepPrevious = false }: { keepPrevious?: boolean } = {},
) {
  const key = JSON.stringify(query);
  // The relay refuses repository requests until a new socket has attached.
  // Waiting for that, and asking again after it, clears an error left by a
  // reconnect. A switch between sessions keeps this true and asks nothing.
  const attached = useSessionTreeStore((s) => s.attachedSession !== null);
  const [state, setState] = useState<{
    key: string;
    refresh: number;
    result?: Result;
    error?: string;
  }>();
  useEffect(() => {
    if (key === "null" || !attached) return;
    const controller = new AbortController();
    repositoryRequest(
      client,
      JSON.parse(key) as RepositoryQuery,
      controller.signal,
    )
      .then((result) => {
        if (!controller.signal.aborted) setState({ key, refresh, result });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setState({
            key,
            refresh,
            error:
              error instanceof Error ? error.message : "Could not load files.",
          });
      });
    return () => controller.abort();
  }, [attached, client, key, refresh]);
  const current =
    state?.key === key && state.refresh === refresh ? state : undefined;
  const shown = current ?? (keepPrevious && query !== null ? state : undefined);
  return {
    result: shown?.result,
    error: shown?.error,
    loading: query !== null && !current,
  };
}

export function Notice({
  children,
  error = false,
}: {
  children: React.ReactNode;
  error?: boolean;
}) {
  return (
    <p
      role={error ? "alert" : "status"}
      className={cn(
        "px-4 py-6 text-sm leading-relaxed",
        error ? "text-destructive" : "text-muted-foreground",
      )}
    >
      {children}
    </p>
  );
}

export function FilePreview({
  result,
  path,
  wrap,
  size,
}: {
  result: Extract<Result, { kind: "read" | "diff" }>;
  path: string;
  wrap: boolean;
  size?: number;
}) {
  const syntax = useRepositorySyntax(
    path,
    result.binary ? "" : result.content,
    result.kind === "diff",
  );
  if (result.kind === "read" && getFileCategory(path) === "image") {
    if (size === undefined)
      return <Notice>Image preview is unavailable for symbolic links.</Notice>;
    if (size > 10 * 1024 * 1024)
      return <Notice>Image exceeds 10 MB preview limit.</Notice>;
    return filesAvailable() ? (
      <ImagePreview key={path} path={path} />
    ) : (
      <Notice>Image preview needs a direct connection to this machine.</Notice>
    );
  }
  if (result.binary)
    return <Notice>Binary file. Text preview is unavailable.</Notice>;
  if (!result.content)
    return (
      <Notice>
        {result.kind === "diff"
          ? "No text differences for this file."
          : "This file is empty."}
      </Notice>
    );
  const lines = result.content.split("\n");
  const visible = lines.slice(0, 10_000);
  const isDiff = result.kind === "diff";
  return (
    <>
      {(result.truncated || lines.length > visible.length) && (
        <p
          role="status"
          className="shrink-0 border-b bg-warning/10 px-3 py-2 text-xs text-foreground"
        >
          Preview shortened. Only part of this file is shown.
        </p>
      )}
      <div
        tabIndex={0}
        role="region"
        aria-label={isDiff ? "File diff" : "File contents"}
        className="min-h-0 flex-1 overflow-auto bg-surface-sunken"
      >
        <div
          className={cn(
            "py-2 font-mono text-code",
            wrap ? "w-full" : "min-w-max",
          )}
        >
          {visible.map((line, index) => (
            <div
              key={index}
              className={cn(
                "flex",
                isDiff && line.startsWith("+")
                  ? "bg-signal-done-surface text-term-added"
                  : isDiff && line.startsWith("-")
                    ? "bg-signal-failed-surface text-term-removed"
                    : isDiff && line.startsWith("@@")
                      ? "bg-muted text-term-path"
                      : isDiff && /^(diff |index |Binary files)/.test(line)
                        ? "text-muted-foreground"
                        : "text-foreground",
              )}
            >
              <span
                aria-hidden="true"
                // In `ch`, so the gutter grows with the code zoom and five
                // digit line numbers still fit.
                className="sticky left-0 mr-3 w-[calc(5ch+0.5rem)] shrink-0 select-none border-r bg-surface-sunken pr-2 text-right tabular-nums text-muted-foreground"
              >
                {index + 1}
              </span>
              <code
                className={cn(
                  "min-w-0 flex-1 pr-4",
                  wrap ? "whitespace-pre-wrap break-all" : "whitespace-pre",
                )}
              >
                <RepositorySyntaxLine line={line} tokens={syntax?.[index]} />
              </code>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

function ImagePreview({ path }: { path: string }) {
  const { url, loading, error } = useFileObjectUrl(path);
  const [decodeError, setDecodeError] = useState(false);
  if (error || decodeError)
    return (
      <Notice error>
        Could not preview this image. File may be missing, too large, or
        inaccessible.
      </Notice>
    );
  if (loading || !url) return <Notice>Loading image...</Notice>;
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-4">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={url}
        alt={path.split("/").pop() ?? "File preview"}
        className="max-h-full max-w-full object-contain"
        onError={() => setDecodeError(true)}
      />
    </div>
  );
}
