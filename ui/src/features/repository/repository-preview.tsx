import { Fragment, useMemo, useState } from "react";
import { machineId as activeMachine } from "@/features/connection/machine-context";
import {
  findOpenHunk,
  normalizeFileLines,
  hunkBlocks,
  hunkKind,
  type FileHunk,
} from "@/features/files/file-hunk";
import { useFileHunks } from "@/features/files/use-file-hunks";
import type { RepositorySyntaxToken } from "./repository-syntax-tokens";
import { parsePatch } from "./commit-diff";
import { CommentableDiffRows } from "./diff-rows";
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
  root,
  jump,
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
  root?: string | null;
  jump?: { id: string; requestId: string };
}) {
  const markdown = result.kind === "read" && rendered && !result.binary && isMarkdownPath(path);
  const source =
    result.kind === "read" && !result.binary && !markdown
      ? normalizeFileLines(result.content)
      : result.content;
  const syntax = useRepositorySyntax(
    path,
    result.binary || markdown ? "" : source,
    result.kind === "diff",
  );
  const patch = useMemo(
    () =>
      result.kind === "diff" && !result.binary
        ? parsePatch(result.content.split("\n", 10000).join("\n"))
        : null,
    [result],
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
  if (!result.content && (result.kind === "diff" || markdown))
    return (
      <Notice>
        {result.kind === "diff" ? "No text differences for this file." : "This file is empty."}
      </Notice>
    );
  const lines = source.split("\n");
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
            {patch && result.kind === "diff" ? (
              <>
                {visible.slice(0, patch.rows[0]?.index ?? visible.length).map((line, index) => (
                  <div key={index} className="px-3 text-muted-foreground">
                    {line}
                  </div>
                ))}
                <div
                  className={
                    wrap
                      ? "[&_code]:whitespace-pre-wrap [&_code]:break-all"
                      : "[&_code]:whitespace-pre"
                  }
                >
                  <CommentableDiffRows
                    root={root ?? undefined}
                    jump={jump}
                    scope={result.scope}
                    machine={machineId}
                    path={path}
                    rows={patch.rows}
                    tokens={syntax}
                    digits={5}
                  />
                </div>
              </>
            ) : (
              <FileSourceRows
                key={JSON.stringify([machineId, path])}
                machine={machineId ?? activeMachine()}
                path={result.truncated ? null : path}
                content={source}
                lines={visible}
                tokens={syntax}
                wrap={wrap}
              />
            )}
          </div>
        </div>
      )}
    </>
  );
}

function FileSourceRows({
  machine,
  path,
  content,
  lines,
  tokens,
  wrap,
}: {
  machine: string;
  path: string | null;
  content: string;
  lines: string[];
  tokens: RepositorySyntaxToken[][] | null | undefined;
  wrap: boolean;
}) {
  const hunks = useFileHunks(machine, path, content);
  const [open, setOpen] = useState<{ hunk: FileHunk; line: number }>();
  if (open && hunks && !hunks.includes(open.hunk)) {
    const match = findOpenHunk(hunks, open.hunk, open.line);
    setOpen(
      match
        ? { hunk: match, line: Math.min(match.end, match.start + open.line - open.hunk.start) }
        : undefined,
    );
  }
  const markers = useMemo(() => {
    const byLine = new Map<number, FileHunk[]>();
    for (const hunk of hunks ?? []) {
      for (let line = hunk.start; line <= Math.min(hunk.end, lines.length); line++) {
        const marks = byLine.get(line) ?? [];
        marks.push(hunk);
        byLine.set(line, marks);
      }
    }
    return byLine;
  }, [hunks, lines.length]);
  if (!content && !hunks?.length) return <Notice>This file is empty.</Notice>;
  return lines.map((text, index) => {
    const line = index + 1;
    const marks = markers.get(line);
    return (
      <Fragment key={line}>
        <div className="flex text-foreground">
          <span className="sticky left-0 mr-3 flex w-[calc(5ch+1.5rem)] shrink-0 select-none items-center justify-end border-r bg-surface-sunken pr-2 tabular-nums text-muted-foreground">
            {marks?.map((hunk) => (
              <button
                key={String(hunk.beforeFirst)}
                type="button"
                className={cn(
                  "file-diff-dot flex h-full flex-1 items-center justify-center",
                  "file-diff-" + hunkKind(hunk),
                )}
                aria-label={`Show ${hunkKind(hunk)} lines at line ${line}`}
                aria-expanded={open?.hunk === hunk}
                onClick={() => setOpen(open?.hunk === hunk ? undefined : { hunk, line })}
              />
            ))}
            <span aria-hidden="true">{line}</span>
          </span>
          <code
            className={cn(
              "min-w-0 flex-1 pr-4",
              wrap ? "whitespace-pre-wrap break-all" : "whitespace-pre",
            )}
          >
            <RepositorySyntaxLine line={text} tokens={tokens?.[index]} />
          </code>
        </div>
        {open?.line === line && marks?.includes(open.hunk) && (
          <div role="region" aria-label="Inline file change" className="file-diff-preview max-h-64">
            {hunkBlocks(open.hunk).map((block) => (
              <pre key={block.className} className={block.className}>
                {block.text}
              </pre>
            ))}
          </div>
        )}
      </Fragment>
    );
  });
}
