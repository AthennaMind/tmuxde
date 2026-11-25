import { useAlertStore } from "@/shared/alert-store";
import { useMainTabsStore, type ChangeScope } from "@/features/workspace/main-tabs-store";
import { usePaneStore } from "@/features/panes/pane-store";
import { DiffSelection } from "./diff-selection";
import { useCommentComposer } from "@/features/files/comment-context";
import { memo, useMemo, useEffect, useRef } from "react";
import { MessageSquarePlus, MessageSquare } from "lucide-react";
import { cn } from "@/shared/utils";
import { lazyComponent } from "@/shared/lazy-component";
import { machineId } from "@/features/connection/machine-context";
import { RepositorySyntaxLine } from "./repository-syntax";
import type { RepositorySyntaxToken } from "./repository-syntax-tokens";
import type { DiffRow } from "./commit-diff";

const CommentComposer = lazyComponent(() =>
  import("@/features/files/comment-composer").then((m) => m.CommentComposer),
);

interface RowProps {
  rows: DiffRow[];
  tokens: RepositorySyntaxToken[][] | undefined;
  digits: number;
}
interface CommentRowsProps extends RowProps {
  path: string;
  oldPath?: string;
  scope: ChangeScope;
  root?: string;
  jump?: { id: string; requestId: string };
  machine?: string;
}
export function CommentableDiffRows({ machine = machineId(), ...props }: CommentRowsProps) {
  return (
    <CommentComposer machine={machine}>
      <PatchRows {...props} />
    </CommentComposer>
  );
}
function PatchRows({ path, oldPath, scope, root, jump, rows, tokens, digits }: CommentRowsProps) {
  const { comments, open } = useCommentComposer();
  const container = useRef<HTMLDivElement>(null);
  const visited = useRef<string | null>(null);
  useEffect(() => {
    if (!jump || visited.current === jump.requestId) return;
    visited.current = jump.requestId;
    const tabs = useMainTabsStore.getState();
    tabs.clearFilePosition(tabs.active, jump.requestId);
    const row = container.current?.querySelector<HTMLElement>(
      `[data-comment-ids~="${CSS.escape(jump.id)}"]`,
    );
    if (row) {
      row.scrollIntoView({ block: "center" });
      row.focus({ preventScroll: true });
    } else {
      useAlertStore
        .getState()
        .push("info", "Diff changed. Review the original selection in the batch.");
    }
  }, [jump, rows]);
  const hunks = useMemo(() => {
    const result = new Map<number, DiffRow[]>();
    let current: DiffRow[] = [];
    for (const row of rows) {
      if (row.kind === "hunk") current = [];
      current.push(row);
      result.set(row.index, current);
    }
    return result;
  }, [rows]);
  function rowKey(row: DiffRow) {
    return JSON.stringify([
      scope,
      hunks.get(row.index)?.[0]?.text,
      row.kind,
      "old" in row ? row.old : null,
      "new" in row ? row.new : null,
      row.text,
    ]);
  }
  const marked = new Map<string, typeof comments>();
  for (const comment of comments) {
    if (!comment.diff || (comment.path !== path && comment.path !== oldPath)) continue;
    for (const key of comment.diff.rows) {
      const list = marked.get(key);
      if (list) list.push(comment);
      else marked.set(key, [comment]);
    }
  }
  function openRange(first: number, last: number, text: string) {
    const selected = rows.filter((row) => row.index >= first && row.index <= last);
    const code = selected.filter(
      (row): row is Extract<DiffRow, { kind: "add" | "del" | "context" }> =>
        row.kind === "context" || row.kind === "add" || row.kind === "del",
    );
    if (!code.length) return;
    const old = code.flatMap((row) => (row.old === undefined ? [] : [row.old]));
    const added = code.flatMap((row) => (row.new === undefined ? [] : [row.new]));
    const location = [describeLines("old", old), describeLines("new", added)]
      .filter(Boolean)
      .join(", ");
    const context = [...new Set(code.map((row) => hunks.get(row.index)!))]
      .map((h) => h.map((r) => r.text).join("\n"))
      .join("\n");
    const selectedPath = oldPath && old.length && !added.length ? oldPath : path;
    open({
      paneId: usePaneStore.getState().activePaneId ?? undefined,
      id: crypto.randomUUID(),
      path: selectedPath,
      snippet: context,
      diff: {
        source: root
          ? { scope, root, relativePath: selectedPath.slice(root.replace(/\/$/, "").length + 1) }
          : undefined,
        scope,
        location:
          oldPath && old.length && added.length
            ? `${location}; original file ${oldPath}`
            : location,
        text,
        rows: code.map(rowKey),
      },
      note: "",
      images: [],
    });
  }
  function renderMarker(row: DiffRow) {
    const matches = marked.get(rowKey(row));
    const existing = matches?.[0];
    if (!existing && row.kind !== "add" && row.kind !== "del")
      return <span className="w-6 shrink-0" />;
    const side = row.kind === "del" ? "removed" : row.kind === "add" ? "added" : "context";
    const line = "new" in row ? row.new : "old" in row ? row.old : undefined;
    const label = `${existing ? "Edit comment on" : "Comment on"} ${side} line ${line}`;
    return (
      <button
        data-comment-ids={matches?.map((c) => c.id).join(" ")}
        data-commented={existing ? "" : undefined}
        type="button"
        aria-label={label}
        title={label}
        className={cn(
          "flex w-6 shrink-0 items-center justify-center rounded hover:bg-accent focus-visible:opacity-100",
          existing ? "text-primary" : "text-muted-foreground opacity-50 group-hover:opacity-100",
        )}
        onClick={() => (existing ? open(existing) : openRange(row.index, row.index, row.text))}
      >
        {existing ? <MessageSquare size={14} /> : <MessageSquarePlus size={14} />}
      </button>
    );
  }
  return (
    <div ref={container}>
      <DiffSelection onComment={openRange}>
        <DiffRows rows={rows} tokens={tokens} digits={digits} marker={renderMarker} />
      </DiffSelection>
    </div>
  );
}
function describeLines(side: string, lines: number[]) {
  if (!lines.length) return "";
  const spans: string[] = [];
  let start = lines[0]!;
  let end = start;
  for (const line of lines.slice(1)) {
    if (line !== end + 1) {
      spans.push(start === end ? String(start) : `${start}-${end}`);
      start = line;
    }
    end = line;
  }
  spans.push(start === end ? String(start) : `${start}-${end}`);
  return `${side} ${lines.length === 1 ? "line" : "lines"} ${spans.join(", ")}`;
}
const ROW_COLORS: Record<DiffRow["kind"], string> = {
  add: "bg-signal-done-surface text-term-added",
  del: "bg-signal-failed-surface text-term-removed",
  hunk: "bg-muted text-term-path",
  note: "text-muted-foreground",
  context: "text-foreground",
};

/** The rows of one diff. Memoized and free of `wrap`, see `FileDiff`. */
export const DiffRows = memo(function DiffRows({
  rows,
  tokens,
  digits,
  marker,
}: {
  rows: DiffRow[];
  tokens: RepositorySyntaxToken[][] | undefined;
  /** Digits of the largest line number, for the gutter width. */
  digits: number;
  marker?: (row: DiffRow) => React.ReactNode;
}) {
  const gutter = { width: `calc(${digits}ch + 0.75rem)` };
  return rows.map((row) => (
    <div key={row.index} className={cn("group flex", ROW_COLORS[row.kind])}>
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
      {marker?.(row)}
      <code
        data-patch-index={
          !marker || row.kind === "hunk" || row.kind === "note" ? undefined : row.index
        }
        className="min-w-0 flex-1 ps-2 pe-4 group-has-[[data-commented]]:underline group-has-[[data-commented]]:decoration-dotted"
      >
        <RepositorySyntaxLine line={row.text} tokens={tokens?.[row.index]} />
      </code>
    </div>
  ));
});
