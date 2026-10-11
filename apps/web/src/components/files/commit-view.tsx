"use client";

import { useId, useMemo, useState } from "react";
import { ChevronRight, Copy } from "lucide-react";
import type { RepoCommitFile, RepoResult } from "@repo/protocol";
import { cn } from "@repo/ui/lib/utils";
import { copyFailureReason, copyText } from "@/lib/clipboard";
import { useAlertStore } from "@/stores/alert-store";
import { parsePatch, splitPath, type DiffRow } from "./commit-diff";
import { formatCommitDate, parseRefs, RefChip } from "./commit-log";
import { ChangeCode } from "./repository-changes";
import { RepositoryFileIcon } from "./repository-file-icon";
import { RepositorySyntaxLine, useRepositorySyntax } from "./repository-syntax";

export type CommitResult = Extract<RepoResult, { kind: "show" }>;

/** Files past this many patch lines start hidden behind a button. */
const LARGE_FILE_LINES = 1500;
/** The file list starts open up to this many files. */
const LIST_OPEN_FILES = 25;

function patchLines(file: RepoCommitFile): number {
  return file.patch ? file.patch.split("\n").length : 0;
}

/**
 * A commit and its whole patch in one scroll: message and metadata, the list
 * of changed files, then every file's diff under a sticky header.
 *
 * Shared by the desktop commit tab and the phone repository browser.
 */
export function CommitDetail({
  result,
  wrap,
  touch = false,
  onOpenCommit,
}: {
  result: CommitResult;
  wrap: boolean;
  /** Touch sizing for the phone. */
  touch?: boolean;
  onOpenCommit: (hash: string) => void;
}) {
  const { files } = result;
  const id = useId();
  const lines = useMemo(() => files.map(patchLines), [files]);
  const large = lines.map((count) => count > LARGE_FILE_LINES);
  // Index to open state. Large files start closed, the rest open.
  const [open, setOpen] = useState<Record<number, boolean>>({});
  const isOpen = (index: number) => open[index] ?? !large[index];
  const allOpen = files.every((_, index) => isOpen(index));
  const setAll = (value: boolean) =>
    setOpen(Object.fromEntries(files.map((_, index) => [index, value])));
  const headerId = (index: number) => `${id}-file-${index}`;

  const jump = (index: number) => {
    setOpen((prev) => ({ ...prev, [index]: true }));
    // After the section opens, so the scroll lands on its final position.
    requestAnimationFrame(() => {
      const header = document.getElementById(headerId(index));
      header?.scrollIntoView({ block: "start" });
      header?.focus({ preventScroll: true });
    });
  };

  return (
    // Desktop chrome face. The phone keeps its own, like the change list.
    <div className={cn("min-h-0 flex-1 overflow-auto", !touch && "font-chrome")}>
      <CommitMeta result={result} touch={touch} onOpenCommit={onOpenCommit} />
      {result.truncated && (
        <p
          role="status"
          className="border-b bg-warning/10 px-4 py-2 text-xs text-foreground"
        >
          Commit is too large to show in full. Later files are cut short or
          missing.
        </p>
      )}
      {result.hidden > 0 && (
        <p role="status" className="border-b px-4 py-2 text-xs text-muted-foreground">
          {result.hidden === 1
            ? "1 file is hidden by file access policy."
            : `${result.hidden} files are hidden by file access policy.`}
        </p>
      )}
      {files.length === 0 ? (
        result.hidden === 0 && (
          <p className="px-4 py-6 text-sm text-muted-foreground">
            No file changes in this commit.
          </p>
        )
      ) : (
        <>
          <FileList
            files={files}
            touch={touch}
            allOpen={allOpen}
            onToggleAll={() => setAll(!allOpen)}
            onJump={jump}
          />
          {files.map((file, index) => (
            <FileSection
              key={`${index}:${file.path}`}
              file={file}
              headerId={headerId(index)}
              open={isOpen(index)}
              lines={lines[index] ?? 0}
              large={large[index] ?? false}
              truncated={result.truncated}
              wrap={wrap}
              touch={touch}
              onToggle={() =>
                setOpen((prev) => ({ ...prev, [index]: !isOpen(index) }))
              }
            />
          ))}
        </>
      )}
    </div>
  );
}

function CommitMeta({
  result,
  touch,
  onOpenCommit,
}: {
  result: CommitResult;
  touch: boolean;
  onOpenCommit: (hash: string) => void;
}) {
  const { commit } = result;
  const refs = parseRefs(commit.refs);
  const committedApart =
    commit.committer !== commit.author || commit.committerDate !== commit.date;
  const copyHash = () =>
    void copyText(commit.hash).then((ok) =>
      useAlertStore
        .getState()
        .push(
          ok ? "success" : "error",
          ok ? "Copied commit hash" : copyFailureReason(),
        ),
    );

  return (
    <header className="border-b px-4 py-4">
      <h2 className="text-base font-semibold leading-snug text-balance [overflow-wrap:anywhere]">
        {commit.subject || "No commit message"}
      </h2>
      {commit.body && (
        <p className="mt-2 max-w-[75ch] whitespace-pre-wrap text-sm leading-relaxed [overflow-wrap:anywhere]">
          {commit.body}
        </p>
      )}
      <dl className="mt-4 grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-4 gap-y-1.5 text-[13px]">
        <dt className="text-muted-foreground">Author</dt>
        <dd className="min-w-0 [overflow-wrap:anywhere]">
          {commit.author}{" "}
          <span className="text-muted-foreground">{commit.email}</span>
        </dd>
        <dt className="text-muted-foreground">Date</dt>
        <dd>
          <time dateTime={commit.date}>{formatCommitDate(commit.date)}</time>
        </dd>
        {committedApart && (
          <>
            <dt className="text-muted-foreground">Committed</dt>
            <dd className="min-w-0 [overflow-wrap:anywhere]">
              {commit.committer},{" "}
              <time dateTime={commit.committerDate}>
                {formatCommitDate(commit.committerDate)}
              </time>
            </dd>
          </>
        )}
        <dt className="text-muted-foreground">Commit</dt>
        <dd className="flex min-w-0 items-center gap-1">
          <span className="min-w-0 break-all font-mono text-xs">
            {commit.hash}
          </span>
          <button
            type="button"
            aria-label="Copy commit hash"
            title="Copy commit hash"
            onClick={copyHash}
            className={cn(
              "flex shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
              touch ? "h-11 w-11" : "h-7 w-7",
            )}
          >
            <Copy className="h-3.5 w-3.5" />
          </button>
        </dd>
        <dt className="text-muted-foreground">
          {commit.parents.length === 1 ? "Parent" : "Parents"}
        </dt>
        <dd className="flex min-w-0 flex-wrap items-center gap-1.5">
          {commit.parents.length === 0 && (
            <span className="text-muted-foreground">
              None. This is the first commit.
            </span>
          )}
          {commit.parents.map((parent) => (
            <button
              key={parent}
              type="button"
              aria-label={`Open parent ${parent.slice(0, 7)}`}
              title={`Open parent ${parent}`}
              onClick={() => onOpenCommit(parent)}
              className={cn(
                "rounded-md border px-1.5 font-mono text-xs hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                touch ? "min-h-11 px-3" : "min-h-6",
              )}
            >
              {parent.slice(0, 7)}
            </button>
          ))}
          {commit.parents.length > 1 && (
            <span className="text-muted-foreground">
              Changes compare with the first parent.
            </span>
          )}
        </dd>
        {refs.length > 0 && (
          <>
            <dt className="text-muted-foreground">Refs</dt>
            <dd className="flex min-w-0 flex-wrap gap-1">
              {refs.map((ref) => (
                <RefChip key={`${ref.kind}:${ref.name}`} commitRef={ref} />
              ))}
            </dd>
          </>
        )}
      </dl>
    </header>
  );
}

function Counts({ file }: { file: Pick<RepoCommitFile, "additions" | "deletions" | "binary"> }) {
  if (file.binary)
    return (
      <span className="shrink-0 text-xs text-muted-foreground">Binary</span>
    );
  // Output stopped before this file's counts.
  if (file.additions === null || file.deletions === null) return null;
  return <LineCounts additions={file.additions} deletions={file.deletions} />;
}

function LineCounts({
  additions,
  deletions,
}: {
  additions: number;
  deletions: number;
}) {
  return (
    <span className="flex shrink-0 gap-1.5 text-xs tabular-nums">
      <span className="text-term-added" aria-hidden>
        +{additions}
      </span>
      <span className="text-term-removed" aria-hidden>
        −{deletions}
      </span>
      <span className="sr-only">
        {additions} lines added, {deletions} removed
      </span>
    </span>
  );
}

function FileList({
  files,
  touch,
  allOpen,
  onToggleAll,
  onJump,
}: {
  files: RepoCommitFile[];
  touch: boolean;
  allOpen: boolean;
  onToggleAll: () => void;
  onJump: (index: number) => void;
}) {
  const totals = files.reduce(
    (sum, file) => ({
      additions: sum.additions + (file.additions ?? 0),
      deletions: sum.deletions + (file.deletions ?? 0),
    }),
    { additions: 0, deletions: 0 },
  );
  return (
    <section aria-label="Changed files" className="border-b">
      <div className="flex items-center gap-3 px-4 py-2 text-[13px]">
        <h3 className="font-medium">
          {files.length === 1 ? "1 file changed" : `${files.length} files changed`}
        </h3>
        <LineCounts {...totals} />
        <button
          type="button"
          onClick={onToggleAll}
          className={cn(
            "ms-auto rounded-md px-2 text-[13px] text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
            touch ? "min-h-11" : "min-h-7",
          )}
        >
          {allOpen ? "Collapse all" : "Expand all"}
        </button>
      </div>
      <details open={files.length <= LIST_OPEN_FILES} className="group/list">
        <summary
          className={cn(
            "flex cursor-pointer list-none items-center gap-1.5 px-4 text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring [&::-webkit-details-marker]:hidden",
            touch ? "min-h-11" : "min-h-7",
          )}
        >
          <ChevronRight
            className="h-3.5 w-3.5 transition-[rotate] duration-150 group-open/list:rotate-90"
            aria-hidden
          />
          File list
        </summary>
        <ul className="pb-2">
          {files.map((file, index) => {
            const { folder, name } = splitPath(file.path);
            return (
              <li key={`${index}:${file.path}`}>
                <button
                  type="button"
                  onClick={() => onJump(index)}
                  title={
                    file.originalPath
                      ? `${file.originalPath} → ${file.path}`
                      : file.path
                  }
                  className={cn(
                    "flex w-full items-center gap-2 px-4 text-start text-[13px] hover:bg-accent/50 focus-visible:bg-accent/50 focus-visible:outline-none",
                    touch ? "min-h-11" : "min-h-7",
                  )}
                >
                  <ChangeCode code={file.status} />
                  <RepositoryFileIcon path={file.path} className="h-3.5 w-3.5" />
                  <span className="flex min-w-0 flex-1">
                    <span className="min-w-0 truncate text-muted-foreground">
                      {folder}
                    </span>
                    <span className="shrink-0">{name}</span>
                  </span>
                  <Counts file={file} />
                </button>
              </li>
            );
          })}
        </ul>
      </details>
    </section>
  );
}

function FileSection({
  file,
  headerId,
  open,
  lines,
  large,
  truncated,
  wrap,
  touch,
  onToggle,
}: {
  file: RepoCommitFile;
  headerId: string;
  open: boolean;
  /** Patch lines, for the size of a diff not laid out yet. */
  lines: number;
  large: boolean;
  truncated: boolean;
  wrap: boolean;
  touch: boolean;
  onToggle: () => void;
}) {
  const bodyId = `${headerId}-body`;
  const { folder, name } = splitPath(file.path);
  return (
    <section aria-labelledby={headerId} className="border-b">
      <h3 className="sticky top-0 z-10">
        <button
          id={headerId}
          type="button"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={onToggle}
          title={
            file.originalPath ? `${file.originalPath} → ${file.path}` : file.path
          }
          className={cn(
            "flex w-full items-center gap-2 border-b bg-background px-3 text-start text-[13px] hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring",
            touch ? "min-h-11" : "min-h-9",
          )}
        >
          <ChevronRight
            className={cn(
              "h-3.5 w-3.5 shrink-0 text-muted-foreground transition-[rotate] duration-150",
              open && "rotate-90",
            )}
            aria-hidden
          />
          <ChangeCode code={file.status} />
          <RepositoryFileIcon path={file.path} className="h-3.5 w-3.5" />
          <span className="flex min-w-0 flex-1 items-baseline">
            <span className="min-w-0 truncate text-muted-foreground">
              {folder}
            </span>
            <span className="shrink-0 font-medium">{name}</span>
            {file.originalPath && (
              <span className="ms-2 min-w-0 truncate text-xs text-muted-foreground">
                from {file.originalPath}
              </span>
            )}
          </span>
          <Counts file={file} />
        </button>
      </h3>
      <div id={bodyId}>
        {open ? (
          // Diffs out of view skip style, layout and paint. Without this a
          // sidebar drag laid out every line of every file on each frame.
          // Rows are 1.3rem at the default code size, enough for a guess the
          // browser replaces with the real size once drawn. Closing unmounts
          // this box, so no stale size outlives it.
          <div
            className="[content-visibility:auto]"
            style={{ containIntrinsicSize: `auto ${lines * 1.3 + 0.5}rem` }}
          >
            <FileDiff file={file} truncated={truncated} wrap={wrap} />
          </div>
        ) : large ? (
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-sm text-muted-foreground">
            Large diff hidden.
            <button
              type="button"
              onClick={onToggle}
              className={cn(
                "rounded-md border px-2 text-[13px] text-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                touch ? "min-h-11" : "min-h-7",
              )}
            >
              Show diff
            </button>
          </p>
        ) : null}
      </div>
    </section>
  );
}

const ROW_COLORS: Record<DiffRow["kind"], string> = {
  add: "bg-signal-done-surface text-term-added",
  del: "bg-signal-failed-surface text-term-removed",
  hunk: "bg-muted text-term-path",
  note: "text-muted-foreground",
  context: "text-foreground",
};

function FileDiff({
  file,
  truncated,
  wrap,
}: {
  file: RepoCommitFile;
  truncated: boolean;
  wrap: boolean;
}) {
  const { meta, rows } = useMemo(() => parsePatch(file.patch), [file.patch]);
  const tokens = useRepositorySyntax(
    file.path,
    file.binary ? "" : file.patch,
    true,
  );
  const digits = useMemo(() => {
    let max = 1;
    for (const row of rows)
      if ("old" in row || "new" in row)
        max = Math.max(max, row.old ?? 0, row.new ?? 0);
    return String(max).length;
  }, [rows]);

  if (file.binary)
    return <Note>Binary file. Text diff is unavailable.</Note>;
  if (!file.patch)
    return (
      <Note>
        {truncated
          ? "Diff not loaded. This commit reached the size limit."
          : "No text changes."}
      </Note>
    );
  const gutter = { width: `calc(${digits}ch + 0.75rem)` };
  return (
    <>
      {meta.length > 0 && (
        <div className="px-4 py-2 font-mono text-xs text-muted-foreground">
          {meta.map((line, index) => (
            <div key={index}>{line}</div>
          ))}
        </div>
      )}
      {rows.length === 0 ? (
        meta.length === 0 && (
          <Note>{file.originalPath ? "Renamed without changes." : "No text changes."}</Note>
        )
      ) : (
        <div
          tabIndex={wrap ? undefined : 0}
          role={wrap ? undefined : "region"}
          aria-label={wrap ? undefined : `Diff of ${file.path}`}
          className={cn(
            "bg-surface-sunken focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring",
            !wrap && "overflow-x-auto",
          )}
        >
          <div
            className={cn(
              "py-1 font-mono text-code",
              wrap ? "w-full" : "min-w-max",
            )}
          >
            {rows.map((row) => (
              <div key={row.index} className={cn("flex", ROW_COLORS[row.kind])}>
                <span
                  aria-hidden
                  // In `ch`, so the gutter grows with the code zoom.
                  className="sticky start-0 flex shrink-0 select-none border-e bg-surface-sunken tabular-nums text-muted-foreground"
                >
                  <span className="pe-2 text-end" style={gutter}>
                    {"old" in row ? row.old : ""}
                  </span>
                  <span className="pe-2 text-end" style={gutter}>
                    {"new" in row ? row.new : ""}
                  </span>
                </span>
                <code
                  className={cn(
                    "min-w-0 flex-1 ps-2 pe-4",
                    wrap ? "whitespace-pre-wrap break-all" : "whitespace-pre",
                  )}
                >
                  <RepositorySyntaxLine
                    line={row.text}
                    tokens={tokens?.[row.index]}
                  />
                </code>
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

function Note({ children }: { children: React.ReactNode }) {
  return <p className="px-4 py-3 text-sm text-muted-foreground">{children}</p>;
}
