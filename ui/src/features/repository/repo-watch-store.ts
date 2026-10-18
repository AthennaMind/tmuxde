import { useEffect, useRef, useState } from "react";
import { create } from "zustand";
import type { RepoChangedMessage, RepoWatchResultMessage } from "@/protocol";
import type { RepositoryClient } from "./repository-request";
import { trimSlash, type RepoChange } from "./repo-change";
import { useConnectionStore } from "@/features/connection/connection-store";
import { usePaneStore } from "@/features/panes/pane-store";
import { useSessionTreeStore } from "@/features/session/session-tree-store";

/** What the server said about one watched repository. */
export interface RepoWatchState {
  ok: boolean;
  /** Part of the work tree is not watched. Keep polling. */
  partial: boolean;
}

interface RepoWatchStore {
  /** Answers to `repo:watch`, by repository root. */
  roots: Record<string, RepoWatchState>;
  /** The newest `repo:changed`. Subscribers compare it by identity. */
  lastChange: RepoChange | null;
  /**
   * Counts the `repo:unwatch` messages that freed a server slot. Only grows,
   * also across `reset`. A refused watch goes out again when it changes.
   */
  released: number;
  applyResult: (msg: RepoWatchResultMessage) => void;
  applyChange: (msg: RepoChangedMessage) => void;
  /** Drop a root after its last holder let go. */
  forget: (root: string) => void;
  /** A `repo:unwatch` went out for a root the server held. */
  freed: () => void;
  /** The server forgets every watch with its socket. */
  reset: () => void;
}

let seq = 0;

export const useRepoWatchStore = create<RepoWatchStore>((set) => ({
  roots: {},
  lastChange: null,
  released: 0,
  applyResult: (msg) => {
    // A refusal without a root names nothing to remember. The caller sees
    // no state for its root and keeps polling.
    if (msg.root === null) return;
    const root = trimSlash(msg.root);
    set((s) => ({
      roots: { ...s.roots, [root]: { ok: msg.ok, partial: msg.partial } },
    }));
  },
  applyChange: (msg) =>
    set({
      lastChange: {
        seq: ++seq,
        root: trimSlash(msg.root),
        git: msg.git,
        refs: msg.refs,
        paths: msg.paths,
        truncated: msg.truncated,
      },
    }),
  forget: (root) =>
    set((s) => {
      const key = trimSlash(root);
      if (!(key in s.roots)) return s;
      const roots = { ...s.roots };
      delete roots[key];
      return { roots };
    }),
  freed: () => set((s) => ({ released: s.released + 1 })),
  reset: () => set({ roots: {}, lastChange: null }),
}));

/** The watch of `root` is live and covers the whole work tree. */
export function watchHealthy(state: RepoWatchState | undefined): boolean {
  return !!state && state.ok && !state.partial;
}

// Components that hold a watch, by root. The server keeps one watch per
// root and connection, so only the last holder sends `repo:unwatch`.
const holders = new Map<string, number>();

/** Count one more holder of `root`. */
export function holdWatch(root: string): void {
  const key = trimSlash(root);
  holders.set(key, (holders.get(key) ?? 0) + 1);
}

/** Count one holder less. True when it was the last one. */
export function releaseWatch(root: string): boolean {
  const key = trimSlash(root);
  const left = (holders.get(key) ?? 0) - 1;
  if (left > 0) {
    holders.set(key, left);
    return false;
  }
  holders.delete(key);
  return true;
}

// Value of `released` each refused root last went out again at. Several
// holders of one root see the same change, and one watch is enough.
const retried = new Map<string, number>();

/**
 * Hold a server watch on `root` until the returned function runs.
 *
 * `watch` sends `repo:watch` and answers false when it had no pane to send
 * it through. Then nothing is held and the returned function does nothing.
 * While the server refuses the root, every slot another root frees sends
 * the watch again, once per freed slot for all holders of the root. The
 * last holder to let go sends `repo:unwatch`.
 */
export function startRepoWatch(
  client: Pick<RepositoryClient, "status" | "send">,
  root: string,
  watch: () => boolean,
): () => void {
  if (!watch()) return () => {};
  const key = trimSlash(root);
  holdWatch(key);
  const stop = useRepoWatchStore.subscribe((s, prev) => {
    if (s.released === prev.released) return;
    if (s.roots[key]?.ok !== false || retried.get(key) === s.released) return;
    if (client.status !== "connected") return;
    retried.set(key, s.released);
    watch();
  });
  return () => {
    stop();
    if (!releaseWatch(key)) return;
    retried.delete(key);
    const store = useRepoWatchStore.getState();
    // A refused root held no slot, so its unwatch frees none.
    const held = store.roots[key]?.ok !== false;
    store.forget(key);
    // A closed socket took the watch with it.
    if (client.status !== "connected") return;
    client.send({ type: "repo:unwatch", root });
    if (held) store.freed();
  };
}

/**
 * Keep a server watch on the repository at `root` while mounted.
 *
 * Sent through the active pane with the captured context folder, like the
 * other repository requests. Sent again after every attach, since a new
 * socket starts without watches, and after a refusal once another root
 * frees a slot. Does nothing when the server lacks the `repo:watch`
 * feature. Returns what the server answered for the root.
 */
export function useRepoWatch(
  client: RepositoryClient | null,
  root: string | null | undefined,
  target: { paneId: string | null; path: string | undefined },
): RepoWatchState | undefined {
  const supported = useConnectionStore((s) => s.features.has("repo:watch"));
  const attached = useSessionTreeStore((s) => s.attachedSession !== null);
  const attachCount = useSessionTreeStore((s) => s.attachCount);
  // The pane and folder may move inside one repository. That needs no new
  // watch, so they are read when the watch is sent.
  const held = useRef(target);
  held.current = target;

  useEffect(() => {
    if (!client || !supported || !attached || !root) return;
    if (client.status !== "connected") return;
    return startRepoWatch(client, root, () => {
      const { paneId, path } = held.current;
      const id = usePaneStore.getState().activePaneId ?? paneId;
      if (!id) return false;
      client.send({
        type: "repo:watch",
        id,
        ...(path?.startsWith("/") ? { path } : {}),
      });
      return true;
    });
  }, [client, supported, attached, attachCount, root]);

  return useRepoWatchStore((s) => (root ? s.roots[trimSlash(root)] : undefined));
}

/**
 * Count the pushes that `match` accepts. The count starts at 0 and only
 * grows, so it can be added to a refresh key to reload quietly.
 */
export function useRepoChangeCount(match: ((change: RepoChange) => boolean) | null): number {
  const [count, setCount] = useState(0);
  const held = useRef(match);
  held.current = match;
  useEffect(
    () =>
      useRepoWatchStore.subscribe((s, prev) => {
        const change = s.lastChange;
        if (!change || change === prev.lastChange) return;
        if (held.current?.(change)) setCount((n) => n + 1);
      }),
    [],
  );
  return count;
}
