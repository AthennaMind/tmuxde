"use client";

import { useEffect, useRef, useState } from "react";
import { isMobileViewport } from "@/lib/mobile-query";

export type RepositoryView = {
  tab: "files" | "changes" | "history";
  directory: string | null;
  filter: string;
  preview: {
    path: string;
    scope?: "staged" | "unstaged" | "untracked";
    size?: number;
  } | null;
  /** A commit open from History. Absent in entries saved before history. */
  commit?: { hash: string; subject: string } | null;
};

type Entry = { id: number; view: RepositoryView };
export type RepositoryHistory = {
  session: string;
  entries: Entry[];
  index: number;
};

const INITIAL_VIEW: RepositoryView = {
  tab: "files",
  directory: null,
  filter: "",
  preview: null,
};
const MAX_ENTRIES = 100;
let nextId = 0;
const sessions = new Map<string, RepositoryHistory>();

export function createRepositoryHistory(
  view: RepositoryView = INITIAL_VIEW,
): RepositoryHistory {
  return {
    session: `${Date.now()}:${++nextId}`,
    entries: [{ id: ++nextId, view }],
    index: 0,
  };
}

function sameView(left: RepositoryView, right: RepositoryView) {
  return (
    left.tab === right.tab &&
    left.directory === right.directory &&
    left.filter === right.filter &&
    left.preview?.path === right.preview?.path &&
    left.preview?.scope === right.preview?.scope &&
    left.preview?.size === right.preview?.size &&
    left.commit?.hash === right.commit?.hash
  );
}

export function navigateRepositoryHistory(
  history: RepositoryHistory,
  view: RepositoryView,
): RepositoryHistory {
  if (sameView(history.entries[history.index]!.view, view)) return history;
  nextId = Math.max(nextId, ...history.entries.map((entry) => entry.id));
  const entries = [
    ...history.entries.slice(0, history.index + 1),
    { id: ++nextId, view },
  ].slice(-MAX_ENTRIES);
  return { ...history, entries, index: entries.length - 1 };
}

export function replaceRepositoryHistory(
  history: RepositoryHistory,
  view: RepositoryView,
): RepositoryHistory {
  if (sameView(history.entries[history.index]!.view, view)) return history;
  const entries = [...history.entries];
  entries[history.index] = { ...entries[history.index]!, view };
  return { ...history, entries };
}

export function moveRepositoryHistory(
  history: RepositoryHistory,
  direction: -1 | 1,
): RepositoryHistory {
  const index = history.index + direction;
  return index < 0 || index >= history.entries.length
    ? history
    : { ...history, index };
}

export function repositoryHistoryState(
  state: unknown,
  paneId: string,
  history: RepositoryHistory,
) {
  return {
    ...(state && typeof state === "object" ? state : {}),
    mobileTab: "files",
    repository: { paneId, history },
  };
}

function isView(value: unknown): value is RepositoryView {
  if (!value || typeof value !== "object") return false;
  const view = value as RepositoryView;
  if (
    !["files", "changes", "history"].includes(view.tab) ||
    (view.directory !== null && typeof view.directory !== "string") ||
    typeof view.filter !== "string"
  )
    return false;
  const commit = view.commit;
  if (
    commit != null &&
    (typeof commit !== "object" ||
      typeof commit.hash !== "string" ||
      !/^[0-9a-f]{40,64}$/.test(commit.hash) ||
      typeof commit.subject !== "string")
  )
    return false;
  const preview = view.preview;
  return (
    preview === null ||
    (typeof preview === "object" &&
      typeof preview.path === "string" &&
      (preview.scope === undefined ||
        ["staged", "unstaged", "untracked"].includes(preview.scope)) &&
      (preview.size === undefined ||
        (Number.isFinite(preview.size) && preview.size >= 0)))
  );
}

export function readRepositoryHistory(
  state: unknown,
  paneId: string,
): RepositoryHistory | null {
  if (!state || typeof state !== "object") return null;
  const value = state as {
    mobileTab?: string;
    repository?: { paneId?: string; history?: RepositoryHistory };
  };
  const history = value.repository?.history;
  if (
    value.mobileTab !== "files" ||
    value.repository?.paneId !== paneId ||
    !history ||
    typeof history.session !== "string" ||
    !Array.isArray(history.entries) ||
    history.entries.length === 0 ||
    history.entries.length > MAX_ENTRIES ||
    !Number.isInteger(history.index) ||
    history.index < 0 ||
    history.index >= history.entries.length ||
    !history.entries.every(
      (entry) => entry && Number.isInteger(entry.id) && isView(entry.view),
    )
  )
    return null;
  return history;
}

function remember(history: RepositoryHistory) {
  sessions.delete(history.session);
  sessions.set(history.session, history);
  if (sessions.size > 12) sessions.delete(sessions.keys().next().value!);
}

function restore(saved: RepositoryHistory) {
  const cached = sessions.get(saved.session);
  const id = saved.entries[saved.index]!.id;
  const index = cached?.entries.findIndex((entry) => entry.id === id) ?? -1;
  return cached && index >= 0 ? { ...cached, index } : saved;
}

export function useRepositoryHistory(paneId: string) {
  const [history, setHistory] = useState(() => {
    const saved = isMobileViewport()
      ? readRepositoryHistory(window.history.state, paneId)
      : null;
    return saved ? restore(saved) : createRepositoryHistory();
  });
  const current = useRef(history);
  const waitingForPop = useRef(false);
  const commit = (next: RepositoryHistory) => {
    current.current = next;
    remember(next);
    setHistory(next);
  };

  useEffect(() => {
    if (!isMobileViewport()) return;
    const register = () => {
      if (window.history.state?.mobileTab !== "files") return;
      window.history.replaceState(
        repositoryHistoryState(window.history.state, paneId, current.current),
        "",
      );
      remember(current.current);
    };
    const onPopState = (event: PopStateEvent) => {
      waitingForPop.current = false;
      const saved = readRepositoryHistory(event.state, paneId);
      if (!saved) return;
      const next = restore(saved);
      current.current = next;
      remember(next);
      setHistory(next);
    };
    register();
    window.addEventListener("mobilehistorychange", register);
    window.addEventListener("popstate", onPopState);
    return () => {
      window.removeEventListener("mobilehistorychange", register);
      window.removeEventListener("popstate", onPopState);
    };
  }, [paneId]);

  const nativeMatches = () => {
    if (!isMobileViewport()) return false;
    const saved = readRepositoryHistory(window.history.state, paneId);
    return (
      saved?.session === current.current.session &&
      saved.entries[saved.index]?.id ===
        current.current.entries[current.current.index]?.id
    );
  };

  const update = (view: RepositoryView, replace: boolean) => {
    if (waitingForPop.current) return;
    const next = replace
      ? replaceRepositoryHistory(current.current, view)
      : navigateRepositoryHistory(current.current, view);
    if (next === current.current) return;
    if (nativeMatches()) {
      window.history[replace ? "replaceState" : "pushState"](
        repositoryHistoryState(window.history.state, paneId, next),
        "",
      );
    }
    commit(next);
  };

  const move = (direction: -1 | 1) => {
    if (waitingForPop.current) return;
    const next = moveRepositoryHistory(current.current, direction);
    if (next === current.current) return;
    if (nativeMatches()) {
      waitingForPop.current = true;
      window.history.go(direction);
    } else {
      commit(next);
    }
  };

  return {
    view: history.entries[history.index]!.view,
    navigate: (view: RepositoryView) => update(view, false),
    replace: (view: RepositoryView) => update(view, true),
    back: () => move(-1),
    forward: () => move(1),
    canBack: history.index > 0,
    canForward: history.index < history.entries.length - 1,
  };
}
