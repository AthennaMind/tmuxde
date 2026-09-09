import type { MetadataRoute } from "next";

import { staticRoutes } from "@/config/site";
import { locales } from "@/i18n/locales";
import { absoluteUrl, languageAlternates } from "@/lib/seo";
import {
  getAllPosts,
  getAllTags,
  TAG_INDEX_MIN_POSTS,
  tagSlug,
} from "@/lib/blog";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const entries: MetadataRoute.Sitemap = [];

  // One entry per static route per locale. `alternates.languages` is what
  // makes Next render the `xhtml:link` hreflang annotations inside
  // <url> — the single most commonly botched part of a multilingual sitemap.
  //
  // Deliberately no `lastModified`: these used to carry the build timestamp,
  // which claimed /privacy and /terms — declared `yearly` two lines down —
  // changed on every deploy. Google drops `lastmod` for a whole site once it
  // catches it lying, so the honest move is to omit what we cannot source.
  // The blog and tag entries below have real dates and keep theirs.
  for (const route of staticRoutes) {
    for (const locale of locales) {
      entries.push({
        url: absoluteUrl(locale.code, route.href),
        changeFrequency: route.changeFrequency,
        priority: route.priority,
        alternates: { languages: languageAlternates(route.href) },
      });
    }
  }

  // Blog posts, per locale (translated and untranslated-fallback copies are
  // both real, servable URLs — see the `untranslated` flag in src/lib/blog.ts).
  for (const locale of locales) {
    const posts = await getAllPosts(locale.code);
    for (const post of posts) {
      const path = `/blog/${post.slug}`;
      entries.push({
        url: absoluteUrl(locale.code, path),
        lastModified: new Date(
          post.frontmatter.updated ?? post.frontmatter.date,
        ),
        changeFrequency: "monthly",
        priority: 0.6,
        alternates: { languages: languageAlternates(path) },
      });
    }
  }

  // Tag pages, per locale — freshness follows the newest post carrying the tag.
  // Only the tags substantial enough to be indexed are submitted; the thin ones
  // still render and are still linked from every post, they are simply not
  // volunteered. A sitemap listing pages we ask robots not to index is a
  // contradiction, and Search Console reports it as one.
  for (const locale of locales) {
    const [tags, posts] = await Promise.all([
      getAllTags(locale.code),
      getAllPosts(locale.code),
    ]);

    for (const { tag, count } of tags) {
      if (count < TAG_INDEX_MIN_POSTS) continue;

      const slug = tagSlug(tag);
      const path = `/blog/tag/${slug}`;
      const newestDate = posts
        .filter((post) =>
          post.frontmatter.tags.some((t) => tagSlug(t) === slug),
        )
        .reduce<string | null>((latest, post) => {
          const candidate = post.frontmatter.updated ?? post.frontmatter.date;
          return !latest || candidate > latest ? candidate : latest;
        }, null);

      entries.push({
        url: absoluteUrl(locale.code, path),
        // A tag only exists because a post carries it, so `newestDate` is
        // always set in practice; the spread just refuses to invent one.
        ...(newestDate ? { lastModified: new Date(newestDate) } : {}),
        changeFrequency: "weekly",
        priority: 0.4,
        alternates: { languages: languageAlternates(path) },
      });
    }
  }

  return entries;
}
