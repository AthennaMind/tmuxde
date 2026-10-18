import type { RepoCommit } from "@/protocol";

/**
 * The loaded list after a new first page, when the old one continues inside
 * it. The old first commit must sit in `next` at some index, and from there
 * on `next` must match the old list commit for commit. Then the commits
 * loaded past what `next` holds stay behind it. Null when nothing older is
 * loaded or the history changed in another way.
 *
 * A new commit on any branch moves the old first page down by one or more
 * rows. That keeps every page loaded past the first.
 */
export function keepOlderPages(
  prev: readonly RepoCommit[],
  next: readonly RepoCommit[],
): RepoCommit[] | null {
  const head = prev[0]?.hash;
  const at = head === undefined ? -1 : next.findIndex((c) => c.hash === head);
  if (at < 0) return null;
  const overlap = next.length - at;
  if (prev.length <= overlap) return null;
  for (let i = 0; i < overlap; i++) if (prev[i]!.hash !== next[at + i]!.hash) return null;
  const shown = new Set(next.map((c) => c.hash));
  return [...next, ...prev.slice(overlap).filter((c) => !shown.has(c.hash))];
}

/**
 * When to ask for a new first page. One request runs at a time. Asks that
 * come while one is in flight wait, and go out as one request once the
 * answer lands. A hidden list asks nothing. It holds no watch and gets no
 * pushes, so it asks once when it is shown again.
 */
export class FirstPageGate {
  private busy = false;
  private stale = false;
  private hidden = false;

  /** Something asked for a new first page. */
  mark(): void {
    this.stale = true;
  }

  /**
   * True when a request should go now: something asked, or the list was
   * hidden since the last call, none is in flight and the list is shown.
   * The caller sends it, and calls `settle` once it ends.
   */
  take(shown: boolean): boolean {
    if (!shown) {
      this.hidden = true;
      return false;
    }
    if (this.hidden) {
      this.hidden = false;
      this.stale = true;
    }
    if (this.busy || !this.stale) return false;
    this.busy = true;
    this.stale = false;
    return true;
  }

  /** The request in flight answered, failed or was dropped. */
  settle(): void {
    this.busy = false;
  }
}
