import type { MetadataRoute } from "next";

import { docData } from "@/lib/page-data";
import { source } from "@/lib/source";

const BASE_URL = "https://docs.mtmux.com";

/**
 * Generated from the Fumadocs page tree rather than hand-listed.
 *
 * The previous hand-maintained array had already fallen behind the content
 * directory — `/docs/pairing` existed on disk and was missing from the sitemap.
 * Deriving it from `source` means adding an MDX file is the only step.
 *
 * `lastModified` is the file's git commit date, from `lastModified: true` on the
 * collection in `source.config.ts`. It used to be `new Date()`, which told
 * crawlers all 22 pages had changed at whatever moment the sitemap was
 * generated — and Google stops trusting `lastmod` across an entire site once it
 * catches it lying. A page git has no date for (added, not yet committed) gets
 * no `lastmod` at all, which costs nothing: freshness is then judged from the
 * page itself.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const pages = source.getPages();

  return pages.map((page) => {
    const { lastModified } = docData(page.data);
    return {
      url: `${BASE_URL}${page.url}`,
      ...(lastModified ? { lastModified } : {}),
      changeFrequency: "monthly" as const,
      priority:
        page.url === "/docs" ? 1 : page.url.split("/").length > 3 ? 0.6 : 0.8,
    };
  });
}
