import { memo, useCallback, useRef, useState } from "react";
import { GitMerge, Tag } from "lucide-react";
import type { RepoCommit } from "@/protocol";
import { cn } from "@/shared/utils";
import { useTreeKeyboard } from "@/features/workspace/use-tree-keyboard";
import { commitAge, formatCommitDate, parseRefs, type CommitRef } from "./commit-format";

const REF_LABEL = { head: "Current", branch: "Branch", tag: "Tag" };

export function RefChip({ commitRef }: { commitRef: CommitRef }) {
  const label = `${REF_LABEL[commitRef.kind]} ${commitRef.name}`;
  return (
    <span
      title={label}
      className={cn(
        "inline-flex min-w-0 max-w-40 shrink items-center gap-1 rounded-sm bg-muted px-1 text-[11px] leading-4 whitespace-nowrap",
        commitRef.kind === "head" ? "font-medium text-foreground" : "text-muted-foreground",
      )}
    >
      {commitRef.kind === "tag" && <Tag className="h-3 w-3 shrink-0" aria-hidden />}
      <span className="sr-only">{REF_LABEL[commitRef.kind]} </span>
      <span className="truncate">{commitRef.name}</span>
    </span>
  );
}

/**
 * Commits as a list of buttons. Arrow keys, Home and End move between rows,
 * and only one row sits in the Tab order.
 */
export function CommitList({
  commits,
  selected,
  onOpen,
  dense = false,
}: {
  commits: RepoCommit[];
  /** Hash of the commit on screen, if any. */
  selected?: string;
  onOpen: (commit: RepoCommit) => void;
  /** Mouse density for the desktop sidebar. Touch rows stay 44px or more. */
  dense?: boolean;
}) {
  const { ref, onKeyDown } = useTreeKeyboard();
  const [focused, setFocused] = useState<string | null>(null);
  // Stable for the memoized rows. Callers pass a fresh arrow each render.
  const latestOpen = useRef(onOpen);
  latestOpen.current = onOpen;
  const open = useCallback((commit: RepoCommit) => latestOpen.current(commit), []);
  const has = (hash: string | null | undefined) => !!hash && commits.some((c) => c.hash === hash);
  const tabStop = has(focused) ? focused : has(selected) ? selected : commits[0]?.hash;

  return (
    <div ref={ref} onKeyDown={onKeyDown} data-tree="">
      <ul aria-label="Commits" className={dense ? "px-1.5 py-1" : "py-1"}>
        {commits.map((commit) => (
          <li
            key={commit.hash}
            // Rows out of view skip layout and paint, so a sidebar resize
            // lays out the dozen on screen, not every loaded page.
            className={cn(
              "[content-visibility:auto]",
              dense ? "[contain-intrinsic-size:auto_3rem]" : "[contain-intrinsic-size:auto_3.5rem]",
            )}
          >
            <CommitRow
              commit={commit}
              selected={commit.hash === selected}
              tabStop={commit.hash === tabStop}
              dense={dense}
              onFocus={setFocused}
              onOpen={open}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Memoized: moving focus or selection redraws two rows, not the list. */
const CommitRow = memo(function CommitRow({
  commit,
  selected,
  tabStop,
  dense,
  onFocus,
  onOpen,
}: {
  commit: RepoCommit;
  selected: boolean;
  tabStop: boolean;
  dense: boolean;
  onFocus: (hash: string) => void;
  onOpen: (commit: RepoCommit) => void;
}) {
  const short = commit.hash.slice(0, 7);
  const refs = parseRefs(commit.refs);
  const shown = refs.slice(0, 2);
  const merge = commit.parents.length > 1;
  return (
    <button
      type="button"
      data-tree-row={commit.hash}
      tabIndex={tabStop ? 0 : -1}
      aria-current={selected ? "true" : undefined}
      title={`${commit.subject}\n${short} by ${commit.author}, ${formatCommitDate(commit.date)}`}
      onFocus={() => onFocus(commit.hash)}
      onClick={() => onOpen(commit)}
      className={cn(
        "flex w-full flex-col gap-0.5 text-start outline-none focus-visible:ring-1 focus-visible:ring-ring",
        dense
          ? "rounded-md px-2 py-1.5"
          : "min-h-14 justify-center px-4 py-2 focus-visible:ring-inset",
        selected ? "bg-accent text-accent-foreground" : "text-foreground hover:bg-accent/50",
      )}
    >
      <span
        className={cn(
          "flex w-full min-w-0 items-center gap-1.5",
          dense ? "text-[13px]" : "text-sm",
        )}
      >
        {merge && (
          <>
            <GitMerge className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
            <span className="sr-only">Merge commit: </span>
          </>
        )}
        <span className="min-w-0 truncate">{commit.subject || short}</span>
      </span>
      <span className="flex w-full min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
        {shown.map((ref) => (
          <RefChip key={`${ref.kind}:${ref.name}`} commitRef={ref} />
        ))}
        {refs.length > shown.length && (
          <span className="shrink-0 tabular-nums">+{refs.length - shown.length}</span>
        )}
        <span className="shrink-0 font-mono tabular-nums">{short}</span>
        <span className="min-w-0 truncate">{commit.author}</span>
        <time dateTime={commit.date} className="ms-auto shrink-0 ps-1 tabular-nums">
          {commitAge(commit.date)}
        </time>
      </span>
    </button>
  );
});
