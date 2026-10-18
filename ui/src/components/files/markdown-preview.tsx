import { useMemo, useRef, type ComponentProps, type ReactNode } from "react";
import Markdown, { type Components, type ExtraProps, type Options } from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import { useFileObjectUrl } from "@/hooks/use-file-object-url";
import { filesAvailable } from "@/lib/file-url";
import {
  codeBlockLanguage,
  createSlugger,
  hastText,
  resolveMarkdownHref,
  splitFrontMatter,
  type MarkdownTarget,
} from "@/lib/markdown";
import { MarkdownCodeBlock } from "./markdown-code-block";
import { MarkdownMermaid } from "./markdown-mermaid";

type HastElement = NonNullable<ExtraProps["node"]>;
const REMARK_PLUGINS = [remarkGfm];
/**
 * GitHub's allowlist plus the classes GFM output needs. Everything else in
 * inline HTML goes: scripts, handlers, styles, frames, unknown tags. Ids and
 * names keep the `user-content-` prefix so page HTML cannot clobber globals.
 */
const SANITIZE_SCHEMA = {
  ...defaultSchema,
  // Dropped with their text. Other unknown tags unwrap and keep their text.
  strip: ["script", "style"],
  attributes: {
    ...defaultSchema.attributes,
    code: [["className", /^language-./]],
    ul: [["className", "contains-task-list"]],
    ol: [["className", "contains-task-list"]],
    li: [["className", "task-list-item"]],
    h2: [["className", "sr-only"]],
    section: [["className", "footnotes"], "dataFootnotes"],
    a: [...(defaultSchema.attributes?.a ?? []), "dataFootnoteRef", "dataFootnoteBackref"],
  },
} satisfies typeof defaultSchema;
const REHYPE_PLUGINS: NonNullable<Options["rehypePlugins"]> = [
  rehypeRaw,
  [rehypeSanitize, SANITIZE_SCHEMA],
];
// The sanitizer prefixes every id once more, so remark must not. Footnote
// links then say `#fn-1` for an element with id `user-content-fn-1`, which
// `scrollTo` below resolves.
const REMARK_REHYPE_OPTIONS: Options["remarkRehypeOptions"] = {
  clobberPrefix: "",
};
const HEADINGS = ["h1", "h2", "h3", "h4", "h5", "h6"] as const;

/**
 * Rendered Markdown for the Files surface. Inline HTML is parsed, then cut
 * down to the sanitize schema above, so a centered logo block survives and a
 * script tag does not. Links and images, from Markdown or HTML, resolve
 * through `resolveMarkdownHref`, so only the external schemes, in-document
 * anchors and paths the relay may read get out.
 */
export function MarkdownPreview({
  path,
  content,
  onOpenPath,
}: {
  path: string;
  content: string;
  /** Open another file from a link. Links render as text without it. */
  onOpenPath?: (path: string) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const { frontMatter, body } = useMemo(() => splitFrontMatter(content), [content]);
  const components = useMemo<Components>(() => {
    const slug = createSlugger();
    // Headings keep their ids across renders of the same body, so a second
    // render pass does not number them again.
    const ids = new Map<number, string>();
    const headingId = (node: HastElement | undefined) => {
      const key = node?.position?.start.offset ?? -1;
      let id = ids.get(key);
      if (id === undefined) {
        id = slug(hastText(node));
        ids.set(key, id);
      }
      return id;
    };
    // Headings carry plain ids. Ids and names from inline HTML and footnotes
    // carry the sanitizer's prefix. A link may mean either.
    const scrollTo = (id: string) => {
      const root = container.current;
      if (!root) return;
      const candidates = [id, `user-content-${id}`].map(CSS.escape);
      const selector = candidates
        .flatMap((value) => [`[id="${value}"]`, `a[name="${value}"]`])
        .join(",");
      root.querySelector<HTMLElement>(selector)?.scrollIntoView({
        block: "start",
      });
    };
    const heading = (Tag: (typeof HEADINGS)[number]) =>
      function Heading({ node, children, ...props }: ComponentProps<typeof Tag> & ExtraProps) {
        return (
          <Tag id={headingId(node)} {...props}>
            {children}
          </Tag>
        );
      };
    return {
      ...Object.fromEntries(HEADINGS.map((tag) => [tag, heading(tag)])),
      a: ({ node: _node, href, target: _target, children, ...props }) => (
        <MarkdownLink
          link={resolveMarkdownHref(path, href ?? "")}
          onOpenPath={onOpenPath}
          scrollTo={scrollTo}
          {...props}
        >
          {children}
        </MarkdownLink>
      ),
      img: ({ node: _node, src, alt, title, width, height }) => (
        <MarkdownImage
          target={resolveMarkdownHref(path, typeof src === "string" ? src : "")}
          alt={alt ?? ""}
          title={title}
          width={width}
          height={height}
        />
      ),
      pre: ({ node, children }) => {
        const code = node?.children.find(
          (child): child is HastElement => child.type === "element" && child.tagName === "code",
        );
        if (!code) return <pre>{children}</pre>;
        const language = codeBlockLanguage(code.properties?.className);
        const source = hastText(code);
        if (language === "mermaid") return <MarkdownMermaid source={source} />;
        return <MarkdownCodeBlock language={language} source={source} />;
      },
      code: ({ node: _node, className: _className, children, ...props }) => (
        <code className="markdown-inline-code" {...props}>
          {children}
        </code>
      ),
      table: ({ node: _node, children, ...props }) => (
        <div className="markdown-table">
          <table {...props}>{children}</table>
        </div>
      ),
    };
  }, [body, onOpenPath, path]);

  return (
    <div
      ref={container}
      tabIndex={0}
      role="region"
      aria-label="Rendered Markdown"
      className="min-h-0 flex-1 overflow-auto"
    >
      <article className="markdown-body py-6">
        {frontMatter !== null && (
          <details className="markdown-front-matter">
            <summary>Front matter</summary>
            <MarkdownCodeBlock language="yaml" source={frontMatter} />
          </details>
        )}
        <Markdown
          remarkPlugins={REMARK_PLUGINS}
          remarkRehypeOptions={REMARK_REHYPE_OPTIONS}
          rehypePlugins={REHYPE_PLUGINS}
          components={components}
        >
          {body}
        </Markdown>
      </article>
    </div>
  );
}

/**
 * `props` are what survived the sanitizer: `title`, `id`, `className`,
 * footnote `data-*` and `aria-*`. They pass through so footnote back
 * references keep their names.
 */
function MarkdownLink({
  link,
  onOpenPath,
  scrollTo,
  children,
  ...props
}: Omit<ComponentProps<"a">, "target"> & {
  link: MarkdownTarget;
  onOpenPath?: (path: string) => void;
  scrollTo: (id: string) => void;
  children?: ReactNode;
}) {
  switch (link.kind) {
    case "anchor":
      return (
        <a
          href={`#${link.id}`}
          {...props}
          onClick={(event) => {
            event.preventDefault();
            scrollTo(link.id);
          }}
        >
          {children}
        </a>
      );
    case "external":
      return (
        <a href={link.href} {...props} target="_blank" rel="noopener noreferrer">
          {children}
        </a>
      );
    case "file":
      // A button, because it opens a tab or preview and never navigates the
      // page. Middle click on a fake href would open a dead route.
      return onOpenPath ? (
        <button
          type="button"
          className="markdown-file-link"
          title={props.title ?? link.path}
          onClick={() => onOpenPath(link.path)}
        >
          {children}
        </button>
      ) : (
        <span title={link.path}>{children}</span>
      );
    default:
      return <span>{children}</span>;
  }
}

/** `width` and `height` are the author's, kept by the sanitizer. */
type ImageSize = Pick<ComponentProps<"img">, "width" | "height">;

function MarkdownImage({
  target,
  alt,
  title,
  ...size
}: ImageSize & {
  target: MarkdownTarget;
  alt: string;
  title?: string;
}) {
  if (target.kind === "file")
    return <LocalImage path={target.path} alt={alt} title={title} {...size} />;
  const label = alt || title || "Image";
  return (
    <span className="markdown-image-note" role="img" aria-label={label}>
      {label}
      {target.kind === "external" && <span aria-hidden="true"> (remote image, not loaded)</span>}
    </span>
  );
}

function LocalImage({
  path,
  alt,
  title,
  width,
  height,
}: ImageSize & {
  path: string;
  alt: string;
  title?: string;
}) {
  const available = typeof window !== "undefined" && filesAvailable();
  const { url, loading, error } = useFileObjectUrl(available ? path : null);
  const name = path.split("/").pop() ?? path;
  if (!available)
    return (
      <span className="markdown-image-note" role="img" aria-label={alt || name}>
        {alt || name} (needs a direct connection to this machine)
      </span>
    );
  if (error)
    return (
      <span className="markdown-image-note" role="img" aria-label={alt || name}>
        {alt || name} (could not load {name})
      </span>
    );
  if (loading || !url)
    return (
      <span className="markdown-image-note" role="img" aria-label={alt || name}>
        {alt || name}
      </span>
    );
  return <img src={url} alt={alt} title={title} width={width} height={height} />;
}
