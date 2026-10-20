import { cn } from "@/shared/utils";
import { Notice } from "@/shared/notice";
import { RepositorySyntaxLine } from "./repository-syntax";
import { useRepositorySyntax } from "./use-syntax-tokens";
import type { RepositoryResult } from "./use-repository-query";
import { getFileViewMode } from "@/features/files/file-utils";
import { MediaPreview } from "@/features/files/media-preview";
import { isMarkdownPath } from "@/features/files/markdown";
import { lazyComponent } from "@/shared/lazy-component";

// The Markdown parser ships only once a Markdown file opens rendered.
const MarkdownPreview = lazyComponent(
  () => import("@/features/files/markdown-preview").then((m) => m.MarkdownPreview),
  <Notice>Loading preview...</Notice>,
);

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
  machineId,
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
  /** Machine the file lives on. The active route by default. */
  machineId?: string;
}) {
  const markdown = result.kind === "read" && rendered && !result.binary && isMarkdownPath(path);
  const syntax = useRepositorySyntax(
    path,
    result.binary || markdown ? "" : result.content,
    result.kind === "diff",
  );
  if (result.kind === "read") {
    // Media by extension. Any other file with bytes that are not text gets
    // the download card.
    const mode = getFileViewMode(path);
    if (mode !== "text" || result.binary)
      return (
        <MediaPreview
          path={path}
          mode={mode === "text" ? "binary" : mode}
          size={size}
          symlink={symlink}
          target={machineId}
        />
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
