/**
 * Filter the files of one commit by extension or glob.
 *
 * Pure. The server sends every file of a commit, so filtering is a view
 * concern. `CommitDetail` uses it for the file list and the diff sections.
 */

export type CommitFilterMode = "hide" | "only";

export interface CommitFileFilter {
  patterns: readonly string[];
  mode: CommitFilterMode;
}

/** The fields of a commit file the filter reads. */
interface FilterableFile {
  path: string;
  originalPath?: string | null;
}

/**
 * Split pattern text on commas and whitespace. Trims, drops empties and
 * duplicates, keeps the order typed.
 */
export function parseFilePatterns(text: string): string[] {
  const seen = new Set<string>();
  for (const token of text.split(/[\s,]+/)) if (token) seen.add(token);
  return [...seen];
}

const GLOB_CHARS = /[*?]/;

/**
 * True for a token that names an extension: `md`, `.md`, `.tar.gz`. A token
 * with a dot that is not the first character, like `README.md`, is a file
 * name instead.
 */
function isExtensionToken(token: string): boolean {
  if (token.includes("/") || GLOB_CHARS.test(token)) return false;
  const body = token.startsWith(".") ? token.slice(1) : token;
  if (!body || body.startsWith(".") || body.endsWith(".")) return false;
  return token.startsWith(".") || !body.includes(".");
}

/**
 * The glob a token stands for. `md` and `.md` become `*.md`. Everything else
 * stays as typed.
 */
export function patternGlob(token: string): string {
  if (!isExtensionToken(token)) return token;
  return `*.${token.startsWith(".") ? token.slice(1) : token}`;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Glob to anchored, case insensitive RegExp. `*` stays in one path segment,
 * `**` crosses segments, `?` is one character.
 */
function globRegExp(glob: string): RegExp {
  let source = "";
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i];
    if (char === "*" && glob[i + 1] === "*") {
      i++;
      // `docs/**/x` also matches `docs/x`.
      if (glob[i + 1] === "/") {
        i++;
        source += "(?:.*/)?";
      } else {
        source += ".*";
      }
    } else if (char === "*") {
      source += "[^/]*";
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += escapeRegExp(char ?? "");
    }
  }
  return new RegExp(`^${source}$`, "i");
}

type Matcher = (path: string) => boolean;

function fileName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/**
 * One token to a path test. A pattern without `/` matches the file name. A
 * pattern with `/` matches the whole repository path, leading `/` optional.
 * A trailing `/` means everything below that folder. A bare word like `md`
 * also matches a file named exactly that, so `Makefile` works.
 */
export function compileFilePattern(token: string): Matcher {
  const glob = patternGlob(token);
  if (!glob.includes("/")) {
    const regExp = globRegExp(glob);
    const exact = isExtensionToken(token) && !token.startsWith(".");
    const name = token.toLowerCase();
    return (path) => {
      const base = fileName(path);
      return regExp.test(base) || (exact && base.toLowerCase() === name);
    };
  }
  let rooted = glob.replace(/^\/+/, "");
  if (rooted.endsWith("/")) rooted += "**";
  const regExp = globRegExp(rooted);
  return (path) => regExp.test(path.replace(/^\/+/, ""));
}

/**
 * The files the filter keeps, each with its index into `files`. A renamed
 * file matches when its new or old path matches. No patterns keeps all.
 */
export function filterCommitFiles<F extends FilterableFile>(
  files: readonly F[],
  filter: CommitFileFilter,
): { index: number; file: F }[] {
  const all = files.map((file, index) => ({ index, file }));
  if (filter.patterns.length === 0) return all;
  const matchers = filter.patterns.map(compileFilePattern);
  const matches = (path: string) => matchers.some((test) => test(path));
  return all.filter(({ file }) => {
    const hit = matches(file.path) || (!!file.originalPath && matches(file.originalPath));
    return filter.mode === "only" ? hit : !hit;
  });
}

/**
 * Extension of a path, lower case, or undefined. The text after the last dot
 * of the name, unless that dot starts the name.
 */
export function fileExtension(path: string): string | undefined {
  const name = fileName(path);
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return undefined;
  return name.slice(dot + 1).toLowerCase();
}

/** Extensions in a commit with their file counts, most common first. */
export function fileExtensions(files: readonly FilterableFile[]): { ext: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const file of files) {
    const ext = fileExtension(file.path);
    if (ext) counts.set(ext, (counts.get(ext) ?? 0) + 1);
  }
  return [...counts]
    .map(([ext, count]) => ({ ext, count }))
    .sort((a, b) => b.count - a.count || a.ext.localeCompare(b.ext));
}

function isExtensionPattern(token: string, ext: string): boolean {
  return patternGlob(token).toLowerCase() === `*.${ext.toLowerCase()}`;
}

/** True when the pattern text holds `*.ext` in any spelling: `ext`, `.ext`. */
export function hasExtensionPattern(text: string, ext: string): boolean {
  return parseFilePatterns(text).some((token) => isExtensionPattern(token, ext));
}

/**
 * Add `*.ext` to the pattern text, or remove every spelling of it when
 * present. Returns the new text, tokens joined by ", ".
 */
export function toggleExtensionPattern(text: string, ext: string): string {
  const tokens = parseFilePatterns(text);
  const kept = tokens.filter((token) => !isExtensionPattern(token, ext));
  if (kept.length === tokens.length) kept.push(`*.${ext}`);
  return kept.join(", ");
}

/** A diff section of the commit view. `hidden` while the filter drops it. */
export interface CommitSection<F> {
  index: number;
  file: F;
  hidden: boolean;
}

/**
 * Indices in `seen` plus the visible ones. Returns `seen` itself when nothing
 * is new, so a state update with the result can bail out.
 */
export function addSeenIndices(
  seen: ReadonlySet<number>,
  visible: readonly { index: number }[],
): ReadonlySet<number> {
  if (visible.every(({ index }) => seen.has(index))) return seen;
  const next = new Set(seen);
  for (const { index } of visible) next.add(index);
  return next;
}

/**
 * Diff sections to render, in commit order. Every visible file, plus each
 * file seen before that the filter drops now, marked hidden. Hidden sections
 * stay mounted, so a pattern typed on the way to another one does not parse
 * and highlight hundreds of diffs again.
 */
export function commitSections<F>(
  files: readonly F[],
  visible: readonly { index: number }[],
  seen: ReadonlySet<number>,
): CommitSection<F>[] {
  const shown = new Set(visible.map(({ index }) => index));
  const sections: CommitSection<F>[] = [];
  files.forEach((file, index) => {
    const hidden = !shown.has(index);
    if (!hidden || seen.has(index)) sections.push({ index, file, hidden });
  });
  return sections;
}

/**
 * Memo compare for a diff section. True when React may skip the render: every
 * prop is the same, or the section was hidden and stays hidden. A hidden
 * section draws nothing, so a change like Wrap lines waits until the filter
 * shows it again. Without it a wrap toggle rendered every hidden diff again.
 */
export function sameSectionProps<P extends { hidden: boolean }>(
  prev: Readonly<P>,
  next: Readonly<P>,
): boolean {
  if (prev.hidden && next.hidden) return true;
  const keys = Object.keys(next) as (keyof P)[];
  return (
    keys.length === Object.keys(prev).length && keys.every((key) => Object.is(prev[key], next[key]))
  );
}

/** Header count. A filter shows the full count too, so it never undercounts. */
export function filesChanged(shown: number, total: number, filtering: boolean): string {
  const noun = total === 1 ? "file" : "files";
  return filtering ? `${shown} of ${total} ${noun} changed` : `${total} ${noun} changed`;
}
