"use client";

import { memo, useCallback, useEffect, useRef, useState } from "react";
import { GitMerge, Tag } from "lucide-react";
import type { RepoCommit } from "@repo/protocol";
import { cn } from "@repo/ui/lib/utils";
import { useTreeKeyboard } from "@/components/sidebar/tree-row";
import { useSessionTreeStore } from "@/stores/session-tree-store";
import {
  repositoryRequest,
  type RepositoryClient,
} from "./repository-request";

export interface CommitLog {
  commits: RepoCommit[];
  more: boolean;
  /** First page in flight with nothing to show yet. */
  loading: boolean;
  loadingMore: boolean;
  /** A refresh someone asked for is in flight. Polls never set this. */
  refreshing: boolean;
  error?: string;
  loadMore: () => void;
}

/**
 * Commit history from HEAD of the repository at `root`, a page at a time.
 *
 * Keyed by repository root, so moving between panes of one repository keeps
 * the list. `refresh` and `tick` ask for the first page again. When HEAD has
 * not moved, that page only refreshes decorations and older pages stay.
 */
export function useCommitLog({
  client,
  paneId,
  path,
  root,
  refresh,
  tick,
}: {
  client: RepositoryClient | null;
  paneId: string | null;
  /** Pane folder the repository was found from. */
  path: string | undefined;
  root: string | null | undefined;
  refresh: number;
  /** Any value that changes on each status poll. */
  tick: unknown;
}): CommitLog {
  const attached = useSessionTreeStore((s) => s.attachedSession !== null);
  const key = client && paneId && path && root && attached ? root : "";
  // Latest request target. A pane switch inside one repository asks nothing.
  const target = useRef({ client, paneId, path });
  target.current = { client, paneId, path };
  // A folder change blanks status until the next answer. Only an answer is a
  // poll, or the gap would ask twice.
  const lastTick = useRef(tick);
  if (tick !== undefined) lastTick.current = tick;
  const poll = lastTick.current;
  const [state, setState] = useState<{
    key: string;
    commits: RepoCommit[];
    more: boolean;
    error?: string;
  }>();
  const [loadingMore, setLoadingMore] = useState(false);
  // Last `refresh` value answered. Differs from `refresh` while one loads.
  const [answered, setAnswered] = useState(refresh);
  const pending = useRef<AbortController | null>(null);

  useEffect(() => {
    const { client, paneId, path } = target.current;
    if (!key || !client || !paneId || !path) return;
    const controller = new AbortController();
    repositoryRequest(
      client,
      { id: paneId, action: "log", path },
      controller.signal,
    )
      .then((result) => {
        if (controller.signal.aborted || result.kind !== "log") return;
        setAnswered(refresh);
        setState((prev) => {
          const same =
            prev?.key === key &&
            prev.commits[0]?.hash === result.commits[0]?.hash;
          // Same HEAD means the same history. Keep pages loaded past the first.
          if (same && prev.commits.length > result.commits.length)
            return {
              key,
              commits: [
                ...result.commits,
                ...prev.commits.slice(result.commits.length),
              ],
              more: prev.more,
            };
          return { key, commits: result.commits, more: result.more };
        });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setAnswered(refresh);
        const message =
          error instanceof Error ? error.message : "Could not load history.";
        setState((prev) =>
          prev?.key === key
            ? { ...prev, error: message }
            : { key, commits: [], more: false, error: message },
        );
      });
    return () => controller.abort();
  }, [key, refresh, poll]);

  // A different repository drops a page request still in flight.
  useEffect(() => {
    return () => {
      pending.current?.abort();
      pending.current = null;
      setLoadingMore(false);
    };
  }, [key]);

  const current = state?.key === key ? state : undefined;
  const loadMore = useCallback(() => {
    const { client, paneId, path } = target.current;
    if (!current?.more || pending.current || !client || !paneId || !path)
      return;
    const controller = new AbortController();
    pending.current = controller;
    setLoadingMore(true);
    repositoryRequest(
      client,
      { id: paneId, action: "log", path, skip: current.commits.length },
      controller.signal,
    )
      .then((result) => {
        if (controller.signal.aborted || result.kind !== "log") return;
        setState((prev) => {
          if (prev?.key !== key) return prev;
          const seen = new Set(prev.commits.map((c) => c.hash));
          return {
            key,
            commits: [
              ...prev.commits,
              ...result.commits.filter((c) => !seen.has(c.hash)),
            ],
            more: result.more,
            error: undefined,
          };
        });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setState((prev) =>
          prev?.key === key
            ? {
                ...prev,
                error:
                  error instanceof Error
                    ? error.message
                    : "Could not load older commits.",
              }
            : prev,
        );
      })
      .finally(() => {
        if (pending.current !== controller) return;
        pending.current = null;
        setLoadingMore(false);
      });
  }, [current, key]);

  return {
    commits: current?.commits ?? [],
    more: current?.more ?? false,
    loading: !!key && !current,
    loadingMore,
    refreshing: !!key && answered !== refresh,
    error: current?.error,
    loadMore,
  };
}

export type CommitRef = { name: string; kind: "head" | "branch" | "tag" };

/** Decorations as chips. `origin/HEAD` and the like only repeat a branch. */
export function parseRefs(refs: string[]): CommitRef[] {
  return refs.flatMap((ref): CommitRef[] => {
    if (ref === "HEAD") return [{ name: "HEAD", kind: "head" }];
    if (ref.startsWith("HEAD -> "))
      return [{ name: ref.slice(8), kind: "head" }];
    if (ref.startsWith("tag: ")) return [{ name: ref.slice(5), kind: "tag" }];
    if (ref.endsWith("/HEAD")) return [];
    return [{ name: ref, kind: "branch" }];
  });
}

const REF_LABEL = { head: "Current", branch: "Branch", tag: "Tag" };

export function RefChip({ commitRef }: { commitRef: CommitRef }) {
  const label = `${REF_LABEL[commitRef.kind]} ${commitRef.name}`;
  return (
    <span
      title={label}
      className={cn(
        "inline-flex min-w-0 max-w-40 shrink items-center gap-1 rounded-sm bg-muted px-1 text-[11px] leading-4 whitespace-nowrap",
        commitRef.kind === "head"
          ? "font-medium text-foreground"
          : "text-muted-foreground",
      )}
    >
      {commitRef.kind === "tag" && (
        <Tag className="h-3 w-3 shrink-0" aria-hidden />
      )}
      <span className="sr-only">{REF_LABEL[commitRef.kind]} </span>
      <span className="truncate">{commitRef.name}</span>
    </span>
  );
}

const dateFormat = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});
const monthDay = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
});
const monthYear = new Intl.DateTimeFormat(undefined, {
  month: "short",
  year: "numeric",
});

export function formatCommitDate(date: string): string {
  const time = new Date(date);
  return Number.isNaN(time.getTime()) ? date : dateFormat.format(time);
}

/** Short age for a row: minutes, hours and days, then a date. */
export function commitAge(date: string, now = Date.now()): string {
  const time = new Date(date);
  if (Number.isNaN(time.getTime())) return "";
  const seconds = Math.floor((now - time.getTime()) / 1000);
  if (seconds < 60) return "now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;
  if (seconds < 30 * 86_400) return `${Math.floor(seconds / 86_400)}d`;
  return time.getFullYear() === new Date(now).getFullYear()
    ? monthDay.format(time)
    : monthYear.format(time);
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
  const open = useCallback(
    (commit: RepoCommit) => latestOpen.current(commit),
    [],
  );
  const has = (hash: string | null | undefined) =>
    !!hash && commits.some((c) => c.hash === hash);
  const tabStop = has(focused)
    ? focused
    : has(selected)
      ? selected
      : commits[0]?.hash;

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
              dense
                ? "[contain-intrinsic-size:auto_3rem]"
                : "[contain-intrinsic-size:auto_3.5rem]",
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
        selected
          ? "bg-accent text-accent-foreground"
          : "text-foreground hover:bg-accent/50",
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
            <GitMerge
              className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
              aria-hidden
            />
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
          <span className="shrink-0 tabular-nums">
            +{refs.length - shown.length}
          </span>
        )}
        <span className="shrink-0 font-mono tabular-nums">{short}</span>
        <span className="min-w-0 truncate">{commit.author}</span>
        <time
          dateTime={commit.date}
          className="ms-auto shrink-0 ps-1 tabular-nums"
        >
          {commitAge(commit.date)}
        </time>
      </span>
    </button>
  );
});
