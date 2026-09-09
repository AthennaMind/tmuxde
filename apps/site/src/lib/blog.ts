import { promises as fs } from "node:fs";
import path from "node:path";

import GithubSlugger from "github-slugger";
import matter from "gray-matter";
import { cache } from "react";
import readingTime from "reading-time";
import { z } from "zod";

import { defaultLocale } from "@/i18n/locales";
import { assertLinkGraph } from "@/lib/link-graph";

const CONTENT_ROOT = path.join(process.cwd(), "content", "blog");

/**
 * Frontmatter contract. A post that fails this schema fails the build with a
 * message naming the file and field — a malformed post must never publish
 * silently with a missing description or a broken date.
 */
export const frontmatterSchema = z.object({
  title: z.string().min(1).max(120),
  description: z.string().min(1).max(300),
  date: z.iso.date(),
  updated: z.iso.date().optional(),
  author: z.string().min(1),
  category: z.enum(["tmux", "agents", "comparisons", "mobile", "security"]),
  /**
   * Optional emoji for the generated cover. Omit it and the cover falls back to
   * the category's glyph — set it only when that default is too generic.
   */
  icon: z.string().min(1).max(8).optional(),
  /**
   * Opt in to `HowTo` structured data, built from the post's first `<Steps>`
   * block.
   *
   * Two conditions, both required, and each catches a different lie. The
   * `<Steps>` block supplies the steps, so the markup can never describe a
   * sequence the reader cannot see. This flag asserts the sequence is a
   * *procedure* — because `<Steps>` is also used for "the ten commands worth
   * memorising", which is a list, and calling it a HowTo would be markup
   * claiming a task the page never performs.
   */
  howTo: z.boolean().default(false),
  tags: z.array(z.string().min(1)).min(1).max(6),
  keywords: z.array(z.string().min(1)).min(1).max(12),
  featured: z.boolean().default(false),
  draft: z.boolean().default(false),
});

export type Frontmatter = z.infer<typeof frontmatterSchema>;

export type TocEntry = {
  depth: 2 | 3;
  text: string;
  id: string;
};

export type Post = {
  slug: string;
  locale: string;
  /** True when this locale has no translation and the default-locale copy is served. */
  untranslated: boolean;
  frontmatter: Frontmatter;
  /** Raw MDX body with frontmatter stripped. */
  body: string;
  readingTimeMinutes: number;
  wordCount: number;
  toc: TocEntry[];
};

/** Headings inside fenced code blocks are not headings. Strip fences first. */
function stripCodeFences(markdown: string): string {
  return markdown.replace(/^```[\s\S]*?^```$/gm, "");
}

/**
 * Builds the table of contents using the same slugger `rehype-slug` uses, so
 * the anchors here always match the ids rendered into the article.
 */
function extractToc(body: string): TocEntry[] {
  const slugger = new GithubSlugger();
  const entries: TocEntry[] = [];

  for (const line of stripCodeFences(body).split("\n")) {
    const match = /^(#{2,3})\s+(.+?)\s*$/.exec(line);
    if (!match) continue;

    // Drop inline markdown so the TOC label reads as plain text.
    const text = match[2]
      .replace(/`([^`]+)`/g, "$1")
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/\*([^*]+)\*/g, "$1")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .trim();

    entries.push({
      depth: match[1].length as 2 | 3,
      text,
      id: slugger.slug(text),
    });
  }

  return entries;
}

async function readPostFile(
  locale: string,
  slug: string,
): Promise<Post | null> {
  const file = path.join(CONTENT_ROOT, locale, `${slug}.mdx`);

  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch {
    return null;
  }

  const { data, content } = matter(raw);
  const parsed = frontmatterSchema.safeParse(data);

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map(
        (issue) => `  · ${issue.path.join(".") || "(root)"}: ${issue.message}`,
      )
      .join("\n");
    throw new Error(
      `Invalid frontmatter in content/blog/${locale}/${slug}.mdx\n${issues}`,
    );
  }

  const stats = readingTime(content);

  return {
    slug,
    locale,
    untranslated: false,
    frontmatter: parsed.data,
    body: content,
    readingTimeMinutes: Math.max(1, Math.round(stats.minutes)),
    wordCount: stats.words,
    toc: extractToc(content),
  };
}

async function listSlugs(locale: string): Promise<string[]> {
  try {
    const files = await fs.readdir(path.join(CONTENT_ROOT, locale));
    return files
      .filter((f) => f.endsWith(".mdx") && !f.startsWith("_"))
      .map((f) => path.basename(f, ".mdx"));
  } catch {
    return [];
  }
}

function isPublished(post: Post): boolean {
  return process.env.NODE_ENV !== "production" || !post.frontmatter.draft;
}

/**
 * All posts for a locale, newest first.
 *
 * Any post missing from `locale` falls back to the default-locale original and
 * is flagged `untranslated`, so a partially translated blog never 404s and the
 * UI can be honest about which language the reader is getting.
 */
export const getAllPosts = cache(async (locale: string): Promise<Post[]> => {
  const localSlugs = new Set(await listSlugs(locale));
  const fallbackSlugs =
    locale === defaultLocale ? [] : await listSlugs(defaultLocale);

  const posts = await Promise.all([
    ...[...localSlugs].map((slug) => readPostFile(locale, slug)),
    ...fallbackSlugs
      .filter((slug) => !localSlugs.has(slug))
      .map(async (slug) => {
        const post = await readPostFile(defaultLocale, slug);
        return post ? { ...post, untranslated: true } : null;
      }),
  ]);

  const published = posts
    .filter((post): post is Post => post !== null)
    .filter(isPublished)
    .sort((a, b) => b.frontmatter.date.localeCompare(a.frontmatter.date));

  // Every route that renders a post goes through here, so this is the one
  // place the link graph can be checked without adding a build step. It runs
  // once per process and is warn-only today — see `src/lib/link-graph.ts`.
  if (locale === defaultLocale) await assertLinkGraph(published);

  return published;
});

export const getPost = cache(
  async (locale: string, slug: string): Promise<Post | null> => {
    const post =
      (await readPostFile(locale, slug)) ??
      (locale === defaultLocale
        ? null
        : await readPostFile(defaultLocale, slug).then((p) =>
            p ? { ...p, untranslated: true } : null,
          ));

    if (!post || !isPublished(post)) return null;
    return post;
  },
);

export const getAllSlugs = cache(async (locale: string): Promise<string[]> => {
  return (await getAllPosts(locale)).map((post) => post.slug);
});

export const getAllTags = cache(
  async (locale: string): Promise<Array<{ tag: string; count: number }>> => {
    const counts = new Map<string, number>();
    for (const post of await getAllPosts(locale)) {
      for (const tag of post.frontmatter.tags) {
        counts.set(tag, (counts.get(tag) ?? 0) + 1);
      }
    }
    return [...counts.entries()]
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
  },
);

/**
 * How many posts a tag needs before its page is worth asking Google to index.
 *
 * A tag page is a list, and a list of one is a worse version of the post it
 * links to — 19 of the 26 tags are in that state. They stay crawlable, because
 * they are useful internal links between related posts, but they ask not to be
 * indexed so the thin ones cannot dilute the pages that do answer a query.
 */
export const TAG_INDEX_MIN_POSTS = 3;

/** URL-safe form of a tag, e.g. "cheat sheet" -> "cheat-sheet". */
export function tagSlug(tag: string): string {
  return tag.toLowerCase().replace(/\s+/g, "-");
}

export const getPostsByTag = cache(
  async (locale: string, tag: string): Promise<Post[]> => {
    const target = tagSlug(tag);
    return (await getAllPosts(locale)).filter((post) =>
      post.frontmatter.tags.some((t) => tagSlug(t) === target),
    );
  },
);

export const getFeaturedPost = cache(
  async (locale: string): Promise<Post | null> => {
    const posts = await getAllPosts(locale);
    return posts.find((post) => post.frontmatter.featured) ?? posts[0] ?? null;
  },
);

/**
 * Related posts, scored by shared tags first, then same category, then
 * recency (which the source ordering already provides).
 */
export const getRelatedPosts = cache(
  async (locale: string, slug: string, limit = 3): Promise<Post[]> => {
    const posts = await getAllPosts(locale);
    const current = posts.find((post) => post.slug === slug);
    if (!current) return posts.slice(0, limit);

    const currentTags = new Set(current.frontmatter.tags.map(tagSlug));

    return posts
      .filter((post) => post.slug !== slug)
      .map((post) => {
        const sharedTags = post.frontmatter.tags.filter((t) =>
          currentTags.has(tagSlug(t)),
        ).length;
        const sameCategory =
          post.frontmatter.category === current.frontmatter.category ? 1 : 0;
        return { post, score: sharedTags * 2 + sameCategory };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((entry) => entry.post);
  },
);
