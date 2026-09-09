import type { TableOfContents } from "fumadocs-core/toc";
import type { ComponentType } from "react";

/**
 * What a compiled MDX doc actually carries.
 *
 * `fumadocs-mdx` generates the collection's types into `.source/`, but the
 * generated module is `// @ts-nocheck` and the loader's `data` widens to a
 * record, so every consumer was reaching for `as any` and an eslint-disable —
 * five copies of the same cast, none of them checked against each other. This
 * declares the shape once so the cast happens in exactly one place.
 */
export interface DocPageData {
  title: string;
  description?: string;
  /** The compiled MDX. Takes the map from `getMDXComponents()`. */
  body: ComponentType<{ components?: Record<string, unknown> }>;
  toc?: TableOfContents;
  /** From `lastModified: true` in `source.config.ts`; absent for uncommitted files. */
  lastModified?: Date;
  /**
   * The page's own content as text.
   *
   * `"processed"` is the compiled Markdown and needs
   * `postprocess.includeProcessedMarkdown` on the collection, which
   * `source.config.ts` sets. Note it is a **method**, not a `_markdown`
   * property on `data` — `fumadocs-mdx` keeps the string under `_exports` and
   * exposes it only through here.
   */
  getText: (type: "raw" | "processed") => Promise<string>;
}

export function docData(data: unknown): DocPageData {
  return data as DocPageData;
}
