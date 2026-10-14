import {
  memo,
  useCallback,
  useDeferredValue,
  useEffect,
  useId,
  useMemo,
  useState,
} from "react";
import { ChevronRight, Copy, Search } from "lucide-react";
import type { RepoCommitFile, RepoResult } from "@repo/protocol";
import { cn } from "@repo/ui/lib/utils";
import { copyFailureReason, copyText } from "@/lib/clipboard";
import { useAlertStore } from "@/stores/alert-store";
import { useSettingsStore } from "@/stores/settings-store";
import { parsePatch, splitPath, type DiffRow } from "./commit-diff";
import {
  addSeenIndices,
  commitSections,
  fileExtensions,
  filesChanged,
  filterCommitFiles,
  hasExtensionPattern,
  parseFilePatterns,
  sameSectionProps,
  toggleExtensionPattern,
  type CommitFilterMode,
  type CommitSection,
} from "./commit-file-filter";
import { formatCommitDate, parseRefs, RefChip } from "./commit-log";
import { ChangeCode } from "./repository-changes";
import { RepositoryFileIcon } from "./repository-file-icon";
import { RepositorySyntaxLine, useRepositorySyntax } from "./repository-syntax";
import type { RepositorySyntaxToken } from "./repository-syntax-tokens";

export type CommitResult = Extract<RepoResult, { kind: "show" }>;

/** Files past this many patch lines start hidden behind a button. */
const LARGE_FILE_LINES = 1500;
/** The file list starts open up to this many files. */
const LIST_OPEN_FILES = 25;
/** Extension chips shown above the file list, most common first. */
const FILTER_CHIPS = 10;

/** A file of the commit with its index into `files`. */
type VisibleFile = { index: number; file: RepoCommitFile };

const NONE_SEEN: ReadonlySet<number> = new Set();

/** Id of a file's section header, the target of the file list jump. */
function sectionHeaderId(id: string, index: number): string {
  return `${id}-file-${index}`;
}

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
  const large = useMemo(
    () => lines.map((count) => count > LARGE_FILE_LINES),
    [lines],
  );
  // Index to open state. Large files start closed, the rest open.
  const [open, setOpen] = useState<Record<number, boolean>>({});
  const isOpen = (index: number) => open[index] ?? !large[index];
  // The filter is a setting, so the next commit opens with it too. The input
  // reads the store itself. Sections follow a deferred copy, so typing stays
  // quick while React filters a big commit in the background.
  const storedText = useSettingsStore((s) => s.commitFilterPatterns);
  const storedMode = useSettingsStore((s) => s.commitFilterMode);
  const patternText = useDeferredValue(storedText);
  const mode = useDeferredValue(storedMode);
  const patterns = useMemo(() => parseFilePatterns(patternText), [patternText]);
  // Pairs keep the index into `files`, which keys open state and header ids.
  const visible = useMemo(
    () => filterCommitFiles(files, { patterns, mode }),
    [files, patterns, mode],
  );
  // Files shown at least once. Their sections stay mounted while hidden.
  const [seen, setSeen] = useState({ files, indices: NONE_SEEN });
  const seenIndices = seen.files === files ? seen.indices : NONE_SEEN;
  useEffect(() => {
    // After commit, so a render React drops never marks files as seen.
    setSeen((prev) => {
      const base = prev.files === files ? prev.indices : NONE_SEEN;
      const indices = addSeenIndices(base, visible);
      return prev.files === files && indices === prev.indices
        ? prev
        : { files, indices };
    });
  }, [files, visible]);
  const sections = useMemo(
    () => commitSections(files, visible, seenIndices),
    [files, visible, seenIndices],
  );
  const allOpen = visible.every(({ index }) => isOpen(index));
  // Hidden files keep their open state for when the filter lets them back.
  const toggleAll = useCallback(
    () =>
      setOpen((prev) => ({
        ...prev,
        ...Object.fromEntries(visible.map(({ index }) => [index, !allOpen])),
      })),
    [visible, allOpen],
  );
  // Stable, so a memoized section re-renders only when its own props change.
  const toggle = useCallback(
    (index: number) =>
      setOpen((prev) => ({ ...prev, [index]: !(prev[index] ?? !large[index]) })),
    [large],
  );
  const jump = useCallback(
    (index: number) => {
      setOpen((prev) => ({ ...prev, [index]: true }));
      // After the section opens, so the scroll lands on its final position.
      requestAnimationFrame(() => {
        const header = document.getElementById(sectionHeaderId(id, index));
        header?.scrollIntoView({ block: "start" });
        header?.focus({ preventScroll: true });
      });
    },
    [id],
  );

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
            visible={visible}
            filtering={patterns.length > 0}
            touch={touch}
            allOpen={allOpen}
            onToggleAll={toggleAll}
            onJump={jump}
          />
          <DiffSections
            id={id}
            sections={sections}
            open={open}
            lines={lines}
            large={large}
            truncated={result.truncated}
            wrap={wrap}
            touch={touch}
            onToggle={toggle}
          />
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

const FileList = memo(function FileList({
  files,
  visible,
  filtering,
  touch,
  allOpen,
  onToggleAll,
  onJump,
}: {
  files: RepoCommitFile[];
  /** Files the filter keeps, with their index into `files`. */
  visible: VisibleFile[];
  filtering: boolean;
  touch: boolean;
  allOpen: boolean;
  onToggleAll: () => void;
  onJump: (index: number) => void;
}) {
  const totals = visible.reduce(
    (sum, { file }) => ({
      additions: sum.additions + (file.additions ?? 0),
      deletions: sum.deletions + (file.deletions ?? 0),
    }),
    { additions: 0, deletions: 0 },
  );
  // From the full commit. A filter that changes the count must not reopen it.
  const [listOpen, setListOpen] = useState(files.length <= LIST_OPEN_FILES);
  return (
    <section aria-label="Changed files" className="border-b">
      {/* Height of the toggle row, so the row keeps its size without it. */}
      <div
        className={cn(
          "flex items-center gap-3 px-4 py-2 text-[13px]",
          touch ? "min-h-15" : "min-h-11",
        )}
      >
        <h3 className="font-medium">
          {filesChanged(visible.length, files.length, filtering)}
        </h3>
        <LineCounts {...totals} />
        {visible.length > 0 && (
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
        )}
      </div>
      <FileFilter
        files={files}
        shown={visible.length}
        filtering={filtering}
        touch={touch}
      />
      {visible.length > 0 && (
        <details
          open={listOpen}
          onToggle={(event) => setListOpen(event.currentTarget.open)}
          className="group/list"
        >
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
            {visible.map(({ index, file }) => (
              <FileListRow
                key={`${index}:${file.path}`}
                index={index}
                file={file}
                touch={touch}
                onJump={onJump}
              />
            ))}
          </ul>
        </details>
      )}
    </section>
  );
});

/** One file of the list. Memoized, so a filter change skips kept rows. */
const FileListRow = memo(function FileListRow({
  index,
  file,
  touch,
  onJump,
}: {
  index: number;
  file: RepoCommitFile;
  touch: boolean;
  onJump: (index: number) => void;
}) {
  const { folder, name } = splitPath(file.path);
  return (
    <li>
      <button
        type="button"
        onClick={() => onJump(index)}
        title={
          file.originalPath ? `${file.originalPath} → ${file.path}` : file.path
        }
        className={cn(
          "flex w-full items-center gap-2 px-4 text-start text-[13px] hover:bg-accent/50 focus-visible:bg-accent/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring",
          touch ? "min-h-11" : "min-h-7",
        )}
      >
        <ChangeCode code={file.status} />
        <RepositoryFileIcon path={file.path} className="h-3.5 w-3.5" />
        <span className="flex min-w-0 flex-1">
          <span className="min-w-0 truncate text-muted-foreground">{folder}</span>
          <span className="shrink-0">{name}</span>
        </span>
        <Counts file={file} />
      </button>
    </li>
  );
});

const MODE_LABELS: Record<CommitFilterMode, string> = {
  hide: "Hide",
  only: "Only",
};

/**
 * Mode, pattern text and extension chips for the files of a commit. Reads
 * and writes the filter in settings, so it outlives this commit.
 */
function FileFilter({
  files,
  shown,
  filtering,
  touch,
}: {
  files: RepoCommitFile[];
  shown: number;
  filtering: boolean;
  touch: boolean;
}) {
  const text = useSettingsStore((s) => s.commitFilterPatterns);
  const mode = useSettingsStore((s) => s.commitFilterMode);
  const setText = useSettingsStore((s) => s.setCommitFilterPatterns);
  const setMode = useSettingsStore((s) => s.setCommitFilterMode);
  const chips = useMemo(
    () => fileExtensions(files).slice(0, FILTER_CHIPS),
    [files],
  );
  const control = touch ? "min-h-11" : "min-h-7";
  const status = !filtering
    ? ""
    : shown === 0
      ? "No files match this filter."
      : `Showing ${shown} of ${files.length} ${files.length === 1 ? "file" : "files"}`;

  return (
    <div className="px-4 pb-2">
      <div className="flex flex-wrap items-center gap-2">
        <div
          role="group"
          aria-label="Filter mode"
          className="flex shrink-0 gap-1"
        >
          {(["hide", "only"] as const).map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={mode === value}
              onClick={() => setMode(value)}
              className={cn(
                "rounded-md border px-2.5 text-[13px] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                control,
                // Same pressed look as the chips. A fill alone is too faint.
                mode === value
                  ? "border-primary bg-primary/10 text-foreground"
                  : "border-transparent text-muted-foreground hover:bg-muted hover:text-foreground",
              )}
            >
              {MODE_LABELS[value]}
            </button>
          ))}
        </div>
        <label
          className={cn(
            "flex min-w-40 flex-1 items-center gap-2 rounded-md border border-input bg-background px-2 focus-within:ring-1 focus-within:ring-ring",
            control,
          )}
        >
          <Search
            className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
            aria-hidden
          />
          <input
            type="text"
            aria-label="File patterns"
            placeholder="*.md, docs/**"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape" && text) {
                event.stopPropagation();
                setText("");
              }
            }}
            className={cn(
              "min-w-0 flex-1 bg-transparent font-mono outline-none placeholder:text-muted-foreground",
              // 16px on the phone, so iOS does not zoom into the field.
              touch ? "py-2 text-base" : "text-xs",
            )}
          />
        </label>
      </div>
      {chips.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {chips.map(({ ext, count }) => {
            const pressed = hasExtensionPattern(text, ext);
            return (
              <button
                key={ext}
                type="button"
                aria-pressed={pressed}
                aria-label={`.${ext}, ${count} ${count === 1 ? "file" : "files"}`}
                onClick={() => setText(toggleExtensionPattern(text, ext))}
                className={cn(
                  "flex items-center gap-1.5 rounded-md border px-2 font-mono text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                  control,
                  // Border and fill, so pressed is not told by color alone.
                  pressed
                    ? "border-primary bg-primary/10 text-foreground"
                    : "border-input text-muted-foreground hover:bg-muted hover:text-foreground",
                )}
              >
                .{ext}
                <span className="tabular-nums text-muted-foreground">{count}</span>
              </button>
            );
          })}
        </div>
      )}
      {/* Status stays mounted so screen readers hear each change. */}
      <div
        className={cn(
          "flex flex-wrap items-center gap-x-3 text-xs",
          filtering && "mt-2",
        )}
      >
        <p role="status" className="text-muted-foreground">
          {status}
        </p>
        {filtering && (
          <button
            type="button"
            onClick={() => setText("")}
            className={cn(
              "rounded-md px-2 text-[13px] text-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
              control,
            )}
          >
            Clear filter
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * The diff of every file the commit view keeps mounted. Memoized, so a
 * keystroke in the filter skips it until the deferred filter result lands.
 */
const DiffSections = memo(function DiffSections({
  id,
  sections,
  open,
  lines,
  large,
  truncated,
  wrap,
  touch,
  onToggle,
}: {
  id: string;
  sections: CommitSection<RepoCommitFile>[];
  /** Open state set by the user, by index. */
  open: Record<number, boolean>;
  lines: number[];
  large: boolean[];
  truncated: boolean;
  wrap: boolean;
  touch: boolean;
  onToggle: (index: number) => void;
}) {
  return sections.map(({ index, file, hidden }) => (
    <FileSection
      key={`${index}:${file.path}`}
      index={index}
      file={file}
      headerId={sectionHeaderId(id, index)}
      hidden={hidden}
      open={open[index] ?? !large[index]}
      lines={lines[index] ?? 0}
      large={large[index] ?? false}
      truncated={truncated}
      wrap={wrap}
      touch={touch}
      onToggle={onToggle}
    />
  ));
});

/**
 * One file's header and diff. Memoized with a stable `onToggle`, so typing a
 * filter or toggling one file does not re-render every other section. While
 * hidden it skips every update, Wrap lines included, until shown again.
 */
const FileSection = memo(function FileSection({
  index,
  file,
  headerId,
  hidden,
  open,
  lines,
  large,
  truncated,
  wrap,
  touch,
  onToggle,
}: {
  index: number;
  file: RepoCommitFile;
  headerId: string;
  /** Dropped by the filter. Stays mounted so its diff is not parsed again. */
  hidden: boolean;
  open: boolean;
  /** Patch lines, for the size of a diff not laid out yet. */
  lines: number;
  large: boolean;
  truncated: boolean;
  wrap: boolean;
  touch: boolean;
  onToggle: (index: number) => void;
}) {
  const bodyId = `${headerId}-body`;
  const { folder, name } = splitPath(file.path);
  return (
    <section aria-labelledby={headerId} hidden={hidden} className="border-b">
      <h3 className="sticky top-0 z-10">
        <button
          id={headerId}
          type="button"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => onToggle(index)}
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
              onClick={() => onToggle(index)}
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
}, sameSectionProps);

const ROW_COLORS: Record<DiffRow["kind"], string> = {
  add: "bg-signal-done-surface text-term-added",
  del: "bg-signal-failed-surface text-term-removed",
  hunk: "bg-muted text-term-path",
  note: "text-muted-foreground",
  context: "text-foreground",
};

/**
 * Memoized. Its props stay the same while the filter changes, and a big
 * commit has thousands of rows to build again otherwise. Wrap lines only
 * changes classes on the rows container, so the rows skip that render too.
 */
const FileDiff = memo(function FileDiff({
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
              // On the container, so a wrap toggle does not touch the rows.
              wrap
                ? "w-full [&_code]:whitespace-pre-wrap [&_code]:break-all"
                : "min-w-max [&_code]:whitespace-pre",
            )}
          >
            <DiffRows rows={rows} tokens={tokens} digits={digits} />
          </div>
        </div>
      )}
    </>
  );
});

/** The rows of one diff. Memoized and free of `wrap`, see `FileDiff`. */
const DiffRows = memo(function DiffRows({
  rows,
  tokens,
  digits,
}: {
  rows: DiffRow[];
  tokens: RepositorySyntaxToken[][] | undefined;
  /** Digits of the largest line number, for the gutter width. */
  digits: number;
}) {
  const gutter = { width: `calc(${digits}ch + 0.75rem)` };
  return rows.map((row) => (
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
      <code className="min-w-0 flex-1 ps-2 pe-4">
        <RepositorySyntaxLine line={row.text} tokens={tokens?.[row.index]} />
      </code>
    </div>
  ));
});

function Note({ children }: { children: React.ReactNode }) {
  return <p className="px-4 py-3 text-sm text-muted-foreground">{children}</p>;
}
