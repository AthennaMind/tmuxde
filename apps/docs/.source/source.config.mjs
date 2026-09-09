// source.config.ts
import { defineDocs, defineConfig } from "fumadocs-mdx/config";
var docs = defineDocs({
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
      includeProcessedMarkdown: true
    }
  }
});
var source_config_default = defineConfig();
export {
  source_config_default as default,
  docs
};
