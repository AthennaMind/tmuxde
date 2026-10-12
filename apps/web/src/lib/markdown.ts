/**
 * Pure helpers behind the Markdown preview. Paths are POSIX and absolute, as
 * the relay reports them. Nothing here touches the DOM, so it runs in tests.
 */

const MARKDOWN_EXTENSIONS = new Set(["md", "markdown"]);

export function isMarkdownPath(path: string): boolean {
  const name = path.split("/").pop()?.toLowerCase() ?? "";
  const dot = name.lastIndexOf(".");
  return dot > 0 && MARKDOWN_EXTENSIONS.has(name.slice(dot + 1));
}

/**
 * YAML front matter: a `---` line first, then `---` or `...` alone on a line.
 * `frontMatter` is the text between, without the fences. Absent fences leave
 * the content untouched.
 */
export function splitFrontMatter(content: string): {
  frontMatter: string | null;
  body: string;
} {
  const match =
    /^---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(
      content,
    );
  if (!match) return { frontMatter: null, body: content };
  return { frontMatter: match[1] ?? "", body: content.slice(match[0].length) };
}

export type MarkdownTarget =
  | { kind: "anchor"; id: string }
  | { kind: "external"; href: string }
  | { kind: "file"; path: string; fragment: string | null }
  | { kind: "unsupported" };

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const EXTERNAL_SCHEMES = new Set(["http:", "https:", "mailto:"]);

/**
 * Where a link or image in `filePath` points. Relative paths resolve against
 * the folder of the file, not the pane directory. Any scheme other than the
 * external set, protocol relative URLs and paths that escape the root are
 * unsupported and render as plain text.
 */
export function resolveMarkdownHref(
  filePath: string,
  href: string,
): MarkdownTarget {
  const value = href.trim();
  if (!value) return { kind: "unsupported" };
  if (value.startsWith("#")) {
    const id = safeDecode(value.slice(1));
    return id ? { kind: "anchor", id } : { kind: "unsupported" };
  }
  const scheme = SCHEME.exec(value)?.[0].toLowerCase();
  if (scheme) {
    return EXTERNAL_SCHEMES.has(scheme)
      ? { kind: "external", href: value }
      : { kind: "unsupported" };
  }
  if (value.startsWith("//") || value.includes("\\")) {
    return { kind: "unsupported" };
  }
  const hash = value.indexOf("#");
  const fragment = hash >= 0 ? safeDecode(value.slice(hash + 1)) || null : null;
  const beforeHash = hash >= 0 ? value.slice(0, hash) : value;
  const query = beforeHash.indexOf("?");
  const rawPath = safeDecode(
    query >= 0 ? beforeHash.slice(0, query) : beforeHash,
  );
  if (!rawPath) {
    return fragment ? { kind: "anchor", id: fragment } : { kind: "unsupported" };
  }
  const path = resolvePath(dirname(filePath), rawPath);
  return path ? { kind: "file", path, fragment } : { kind: "unsupported" };
}

export function dirname(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash <= 0 ? "/" : path.slice(0, slash);
}

/** Join and normalize. `null` when `..` climbs above the root. */
export function resolvePath(base: string, target: string): string | null {
  const parts = target.startsWith("/") ? [] : base.split("/").filter(Boolean);
  for (const segment of target.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (!parts.length) return null;
      parts.pop();
      continue;
    }
    parts.push(segment);
  }
  return `/${parts.join("/")}`;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * GitHub style heading ids: lower case, punctuation dropped, spaces to
 * hyphens, repeats numbered. One slugger per document keeps the numbering.
 */
export function createSlugger(): (text: string) => string {
  const seen = new Map<string, number>();
  return (text) => {
    const base =
      text
        .toLowerCase()
        .trim()
        .replace(/[^\p{L}\p{N}\s_-]/gu, "")
        .replace(/\s+/g, "-") || "section";
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return count ? `${base}-${count}` : base;
  };
}

type HastLike = { type: string; value?: string; children?: HastLike[] };

/** Text content of a hast node, as `textContent` would give in the DOM. */
export function hastText(node: HastLike | undefined): string {
  if (!node) return "";
  if (node.type === "text") return node.value ?? "";
  return node.children?.map(hastText).join("") ?? "";
}

/** Language from a fenced block's `language-*` class, lower case. */
export function codeBlockLanguage(className: unknown): string | undefined {
  const value = Array.isArray(className)
    ? className.join(" ")
    : typeof className === "string"
      ? className
      : "";
  return /(?:^|\s)language-([\w+#.-]+)/.exec(value)?.[1]?.toLowerCase();
}
