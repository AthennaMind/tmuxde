/**
 * One `repo:changed` push as the UI keeps it. `seq` grows with every push,
 * so two equal changes in a row still count twice.
 */
export interface RepoChange {
  seq: number;
  root: string;
  git: boolean;
  /** HEAD or a ref moved, so history may differ. Implies `git`. */
  refs: boolean;
  paths: string[];
  truncated: boolean;
}

/** A path without its trailing slash. The file system root stays "/". */
export function trimSlash(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

/**
 * `path` relative to `root`, "" for the root itself, or null when `path` is
 * outside it.
 */
export function relativeTo(root: string, path: string): string | null {
  const base = trimSlash(root);
  const full = trimSlash(path);
  if (full === base) return "";
  const prefix = base === "/" ? "/" : `${base}/`;
  return full.startsWith(prefix) ? full.slice(prefix.length) : null;
}

/** The change is for the repository at `root`. */
export function sameRoot(change: RepoChange, root: string): boolean {
  return trimSlash(change.root) === trimSlash(root);
}

function parent(rel: string): string {
  const cut = rel.lastIndexOf("/");
  return cut < 0 ? "" : rel.slice(0, cut);
}

/**
 * The listing of `folder` may be out of date. True when an entry right in
 * the folder or the folder itself changed, or when the change was cut short
 * and could hold anything. Changes deeper down leave this listing alone.
 */
export function changeTouchesFolder(change: RepoChange, folder: string): boolean {
  const rel = relativeTo(change.root, folder);
  if (rel === null) return false;
  if (change.truncated) return true;
  return change.paths.some((path) => path === rel || parent(path) === rel);
}

/** The file at absolute `file` may have changed. */
export function changeTouchesFile(change: RepoChange, file: string): boolean {
  const rel = relativeTo(change.root, file);
  if (rel === null || rel === "") return false;
  return change.truncated || change.paths.includes(rel);
}

/**
 * A diff of `file`, relative to the repository at `root`, may have changed.
 * Staged and unstaged diffs also follow the index and HEAD, so `git` counts
 * for them.
 */
export function changeTouchesDiff(
  change: RepoChange,
  root: string,
  file: string,
  followsGit: boolean,
): boolean {
  if (!sameRoot(change, root)) return false;
  return (
    change.truncated ||
    (followsGit && change.git) ||
    change.paths.includes(file)
  );
}
