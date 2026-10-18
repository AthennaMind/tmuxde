import { useState } from "react";
import { cn } from "@/shared/utils";
import { useFileObjectUrl } from "@/shared/use-file-object-url";
import { RepositorySyntaxLine } from "./repository-syntax";
import { useRepositorySyntax } from "./use-syntax-tokens";
import type { RepositoryResult } from "./use-repository-query";
import { filesAvailable } from "@/features/files/file-url";
import { getFileCategory } from "@/features/files/file-utils";
import { isMarkdownPath } from "@/features/files/markdown";
import { lazyComponent } from "@/shared/lazy-component";

// The Markdown parser ships only once a Markdown file opens rendered.
const MarkdownPreview = lazyComponent(
  () => import("@/features/files/markdown-preview").then((m) => m.MarkdownPreview),
  <Notice>Loading preview...</Notice>,
);

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

/**
 * The file preview, shared by the mobile repository browser, the desktop
 * sidebar and desktop file tabs.
 */
export function FilePreview({
  result,
  path,
  wrap,
  size,
  symlink = false,
  rendered = false,
  onOpenPath,
}: {
  result: Extract<RepositoryResult, { kind: "read" | "diff" }>;
  path: string;
  wrap: boolean;
  /** Unknown for a file opened from a Markdown link. */
  size?: number;
  /** The tree listed this path as a symbolic link. */
  symlink?: boolean;
  /** Show a Markdown file rendered instead of as source. */
  rendered?: boolean;
  /** Open a file linked from rendered Markdown. */
  onOpenPath?: (path: string) => void;
}) {
  const markdown = result.kind === "read" && rendered && !result.binary && isMarkdownPath(path);
  const syntax = useRepositorySyntax(
    path,
    result.binary || markdown ? "" : result.content,
    result.kind === "diff",
  );
  if (result.kind === "read" && getFileCategory(path) === "image") {
    if (symlink) return <Notice>Image preview is unavailable for symbolic links.</Notice>;
    if (size !== undefined && size > 10 * 1024 * 1024)
      return <Notice>Image exceeds 10 MB preview limit.</Notice>;
    return filesAvailable() ? (
      <ImagePreview key={path} path={path} />
    ) : (
      <Notice>Image preview needs a direct connection to this machine.</Notice>
    );
  }
  if (result.binary) return <Notice>Binary file. Text preview is unavailable.</Notice>;
  if (!result.content)
    return (
      <Notice>
        {result.kind === "diff" ? "No text differences for this file." : "This file is empty."}
      </Notice>
    );
  const lines = result.content.split("\n");
  const visible = lines.slice(0, 10_000);
  const isDiff = result.kind === "diff";
  return (
    <>
      {(result.truncated || (!markdown && lines.length > visible.length)) && (
        <p
          role="status"
          className="shrink-0 border-b bg-warning/10 px-3 py-2 text-xs text-foreground"
        >
          Preview shortened. Only part of this file is shown.
        </p>
      )}
      {markdown ? (
        <MarkdownPreview path={path} content={result.content} onOpenPath={onOpenPath} />
      ) : (
        <div
          tabIndex={0}
          role="region"
          aria-label={isDiff ? "File diff" : "File contents"}
          className="min-h-0 flex-1 overflow-auto bg-surface-sunken"
        >
          <div className={cn("py-2 font-mono text-code", wrap ? "w-full" : "min-w-max")}>
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
      )}
    </>
  );
}

function ImagePreview({ path }: { path: string }) {
  const { url, loading, error } = useFileObjectUrl(path);
  const [decodeError, setDecodeError] = useState(false);
  if (error || decodeError)
    return (
      <Notice error>
        Could not preview this image. File may be missing, too large, or inaccessible.
      </Notice>
    );
  if (loading || !url) return <Notice>Loading image...</Notice>;
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-4">
      <img
        src={url}
        alt={path.split("/").pop() ?? "File preview"}
        className="max-h-full max-w-full object-contain"
        onError={() => setDecodeError(true)}
      />
    </div>
  );
}
