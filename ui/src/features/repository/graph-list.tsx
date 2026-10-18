import { memo, useMemo, useState } from "react";
import type { RepoCommit } from "@/protocol";
import { cn } from "@/shared/utils";
import { useTreeKeyboard } from "@/features/workspace/use-tree-keyboard";
import { RefChip } from "./commit-log";
import { commitAge, formatCommitDate, parseRefs } from "./commit-format";
import { graphOrder, layoutGraph, type GraphRow } from "./graph-layout";
import { EDGE, LANE, MAX_LANES, MID, ROW, laneX } from "./graph-geometry";
import { sameRowProps, type GraphRowProps } from "./graph-row-props";

/** Lane colors, by `GraphRow.color`. Six, like `GRAPH_COLORS`. */
const LANE_COLORS = [
  "text-chart-1",
  "text-chart-4",
  "text-chart-2",
  "text-chart-3",
  "text-chart-5",
  "text-primary",
];

const x = laneX;

/**
 * Commits with their graph, newest first, every child before its parents.
 * Each row is a button that opens the commit. Arrow keys, Home and End move
 * between rows, and only one row sits in the Tab order.
 *
 * Memoized, and each row is memoized by value with `sameRowProps`. A new
 * first page renders only the rows that look different. Thousands of loaded
 * rows would block the page otherwise. Both need a stable `onOpen`.
 */
export const GraphList = memo(function GraphList({
  commits,
  selected,
  onOpen,
}: {
  commits: RepoCommit[];
  /** Hash of the commit tab on screen, if any. */
  selected?: string;
  /**
   * Keep it stable. Rows take it as is and all render again when it changes.
   * `CommitList` keeps the latest callback instead, because its callers
   * rebuild theirs from navigation state on every render. The one caller here
   * memoizes it.
   */
  onOpen: (commit: RepoCommit) => void;
}) {
  // Git's order can put a parent before a child. Rows follow the fixed order.
  const ordered = useMemo(() => graphOrder(commits), [commits]);
  const rows = useMemo(() => layoutGraph(ordered), [ordered]);
  const { ref, onKeyDown } = useTreeKeyboard();
  const [focused, setFocused] = useState<string | null>(null);
  const has = (hash: string | null | undefined) => !!hash && commits.some((c) => c.hash === hash);
  const tabStop = has(focused) ? focused : has(selected) ? selected : commits[0]?.hash;

  return (
    <div ref={ref} onKeyDown={onKeyDown} data-tree="">
      <ul aria-label="Commits" className="py-1">
        {ordered.map((commit, i) => (
          <GraphRowItem
            key={commit.hash}
            commit={commit}
            row={rows[i]!}
            selected={commit.hash === selected}
            tabStop={commit.hash === tabStop}
            onFocus={setFocused}
            onOpen={onOpen}
          />
        ))}
      </ul>
    </div>
  );
});

const GraphRowItem = memo(function GraphRowItem({
  commit,
  row,
  selected,
  tabStop,
  onFocus,
  onOpen,
}: GraphRowProps) {
  const short = commit.hash.slice(0, 7);
  const refs = parseRefs(commit.refs);
  const shown = refs.slice(0, 3);
  const merge = commit.parents.length > 1;
  const head = refs.some((r) => r.kind === "head");
  return (
    <li
      // Rows out of view skip layout and paint.
      className="[content-visibility:auto] [contain-intrinsic-size:auto_28px]"
    >
      <button
        type="button"
        data-tree-row={commit.hash}
        tabIndex={tabStop ? 0 : -1}
        aria-current={selected ? "true" : undefined}
        onFocus={() => onFocus(commit.hash)}
        onClick={() => onOpen(commit)}
        className={cn(
          "flex h-[28px] w-full items-center gap-2 border-s-2 pe-3 ps-1.5 text-start text-[13px] outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring",
          // A bar marks the open commit. The fill alone is too faint.
          selected
            ? "border-primary bg-accent text-accent-foreground"
            : "border-transparent text-foreground hover:bg-accent/50",
        )}
      >
        <GraphCell row={row} merge={merge} head={head} />
        {merge && <span className="sr-only">Merge commit: </span>}
        {shown.length > 0 && (
          <span className="flex min-w-0 max-w-[40%] shrink items-center gap-1">
            {shown.map((ref) => (
              <RefChip key={`${ref.kind}:${ref.name}`} commitRef={ref} />
            ))}
            {refs.length > shown.length && (
              <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                +{refs.length - shown.length}
              </span>
            )}
          </span>
        )}
        <span className="min-w-0 flex-1 truncate" title={commit.subject}>
          {commit.subject || short}
        </span>
        <span
          className="w-32 shrink-0 truncate text-xs text-muted-foreground"
          title={commit.author}
        >
          {commit.author}
        </span>
        <time
          dateTime={commit.date}
          title={formatCommitDate(commit.date)}
          className="w-14 shrink-0 text-end text-xs tabular-nums text-muted-foreground"
        >
          {commitAge(commit.date)}
        </time>
        <span className="w-14 shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
          {short}
        </span>
      </button>
    </li>
  );
}, sameRowProps);

/**
 * The lanes of one row. Lines in from above end at the centre. Edges run
 * from the centre to the bottom, where the next row picks them up.
 *
 * Only the first `MAX_LANES` lanes are drawn. A node in a later lane gets a
 * small hollow marker past the last lane and a title that names its lane,
 * so it never sits on a lane it does not belong to. Lines that stay in the
 * hidden lanes are left out. Lines between a hidden and a drawn lane run to
 * the right edge.
 */
export function GraphCell({ row, merge, head }: { row: GraphRow; merge: boolean; head: boolean }) {
  const lanes = Math.min(row.lanes, MAX_LANES);
  const hidden = row.lanes - lanes;
  const offscreen = row.lane >= MAX_LANES;
  const node = x(row.lane);
  const width = lanes * LANE + (offscreen ? EDGE : 0);
  const drawn = (lane: number) => lane < MAX_LANES;
  const tops = new Map<number, number>();
  for (const edge of row.edges)
    if (edge.from !== row.lane && drawn(edge.from)) tops.set(edge.from, edge.color);
  if (row.child && !offscreen) tops.set(row.lane, row.color);
  const edges = row.edges.filter((e) => drawn(e.from) || drawn(e.to));
  const title = [
    head ? "Current commit." : merge ? "Merge commit." : "",
    offscreen ? `In lane ${row.lane + 1}. Only the first ${MAX_LANES} lanes are drawn.` : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <span className="flex shrink-0 items-center" title={title || undefined}>
      <svg
        width={width}
        height={ROW}
        viewBox={`0 0 ${width} ${ROW}`}
        aria-hidden
        className="block shrink-0"
        fill="none"
        strokeWidth={1.5}
        strokeLinecap="round"
      >
        {[...tops].map(([lane, color]) => (
          <path
            key={`top:${lane}`}
            d={`M${x(lane)} 0V${MID}`}
            stroke="currentColor"
            className={LANE_COLORS[color]}
          />
        ))}
        {edges.map((edge) => {
          const from = x(edge.from);
          const to = x(edge.to);
          const d =
            from === to
              ? `M${from} ${MID}V${ROW}`
              : `M${from} ${MID}C${from} ${ROW - 4} ${to} ${MID + 4} ${to} ${ROW}`;
          return (
            <path
              key={`${edge.from}:${edge.to}`}
              d={d}
              stroke="currentColor"
              className={LANE_COLORS[edge.color]}
            />
          );
        })}
        <g className={LANE_COLORS[row.color]}>
          {offscreen ? (
            <circle
              data-node="offscreen"
              cx={lanes * LANE + EDGE / 2}
              cy={MID}
              r={2.5}
              stroke="currentColor"
              strokeWidth={1.5}
              className="fill-background"
            />
          ) : head ? (
            <>
              <circle
                cx={node}
                cy={MID}
                r={5.5}
                stroke="currentColor"
                strokeWidth={2}
                className="fill-background"
              />
              <circle cx={node} cy={MID} r={2.5} fill="currentColor" />
            </>
          ) : merge ? (
            <circle
              cx={node}
              cy={MID}
              r={4}
              stroke="currentColor"
              strokeWidth={2}
              className="fill-background"
            />
          ) : (
            <circle cx={node} cy={MID} r={4} fill="currentColor" />
          )}
        </g>
      </svg>
      {hidden > 0 && (
        <span
          className="ps-1 text-xs tabular-nums text-muted-foreground"
          title={`${hidden} more lanes`}
        >
          +{hidden}
        </span>
      )}
    </span>
  );
}
