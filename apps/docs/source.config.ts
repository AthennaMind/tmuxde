import { defineDocs, defineConfig } from "fumadocs-mdx/config";

/**
 * The `docs` collection.
 *
 * No `schema` is passed: `defineDocs` already validates frontmatter with
 * `pageSchema` from `fumadocs-core/source/schema` (title, description, icon,
 * full), which is exactly what these pages use. The `frontmatterSchema` export
 * some older guides reach for is deprecated in Fumadocs 16 — if a field is ever
 * needed here, extend `pageSchema`, do not resurrect that.
 */
export const docs = defineDocs({
  dir: "content/docs",
  docs: {
    /**
     * Per-page last-modified date, read from `git log` for each file.
     *
     * The sitemap needs an honest `lastmod` — it previously had none, because
     * the only other candidate was `new Date()`, which tells crawlers all 22
     * pages changed the instant the sitemap was built and gets `lastmod`
     * distrusted site-wide once Google notices. Git commit dates are the real
     * edit times.
     *
     * Note the API: `lastModified: true`. It is **not** `lastModifiedTime:
     * "git"` — that was the Fumadocs 14 spelling and is gone.
     *
     * A file with no commit yet (a page added but not committed) simply has no
     * date, and the sitemap omits `lastmod` for it rather than inventing one.
     */
    lastModified: true,
    postprocess: {
      /**
       * Makes `page.data.getText("processed")` available, which is what
       * `/llms-full.txt` serves and what the FAQ/HowTo extractors read. Reading
       * the same source the reader sees is the point: structured data cannot
       * then claim a step or a question the page does not actually contain.
       */
      includeProcessedMarkdown: true,
    },
  },
});

export default defineConfig();
