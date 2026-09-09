import { siteConfig, staticRoutes } from "@/config/site";
import { defaultLocale } from "@/i18n/locales";
import { loadMessages } from "@/i18n/messages";
import { getAllPosts } from "@/lib/blog";
import { absoluteUrl } from "@/lib/seo";

export const dynamic = "force-static";

type MessageTree = Record<string, unknown>;

function readString(
  tree: MessageTree,
  path: readonly string[],
): string | undefined {
  let node: unknown = tree;
  for (const key of path) {
    if (typeof node !== "object" || node === null) return undefined;
    node = (node as MessageTree)[key];
  }
  return typeof node === "string" ? node : undefined;
}

/**
 * The two routes whose copy does not live in a file named after them: privacy
 * and terms share `messages/en/legal.json`. Deriving the namespace from the
 * route sent both lookups to a `privacy`/`terms` namespace that has never
 * existed, so the only two pages a crawler most wants summarised — what we
 * collect, and what you are agreeing to — shipped with no description at all.
 */
const MESSAGE_PATHS: Record<string, readonly string[]> = {
  "/privacy": ["legal", "privacy"],
  "/terms": ["legal", "terms"],
};

/** `/` -> `home`, `/use-cases` -> `use-cases` — matches the `messages/en/*.json` filenames. */
function routeNamespace(href: string): string {
  return href === "/" ? "home" : href.slice(1).split("/")[0];
}

/** Where a route's `meta.*` strings live in the message tree. */
function messagePath(href: string): readonly string[] {
  return MESSAGE_PATHS[href] ?? [routeNamespace(href)];
}

/** Turns `/use-cases` into "Use cases" when a page has no `meta.title` yet. */
function titleCaseFromRoute(href: string): string {
  const slug = href === "/" ? "home" : href.slice(1);
  const words = slug.split(/[-/]/).filter(Boolean);
  return words.map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
}

/**
 * Curated Markdown for LLM crawlers and answer engines at `/llms.txt`
 * (see https://llmstxt.org). Every page and post listed here is read live
 * from `staticRoutes` / `src/lib/blog.ts` — nothing below is hand-maintained,
 * so the file can never drift out of date with the actual site.
 */
export async function GET() {
  const messages = (await loadMessages(defaultLocale)) as MessageTree;
  const posts = await getAllPosts(defaultLocale);

  const intro =
    readString(messages, ["home", "meta", "description"]) ??
    readString(messages, ["common", "defaultDescription"]) ??
    siteConfig.name;

  const pageLines = staticRoutes.map((route) => {
    const base = messagePath(route.href);
    const title =
      readString(messages, [...base, "meta", "title"]) ??
      titleCaseFromRoute(route.href);
    const description = readString(messages, [...base, "meta", "description"]);
    const url = absoluteUrl(defaultLocale, route.href);
    return description
      ? `- [${title}](${url}): ${description}`
      : `- [${title}](${url})`;
  });

  const postLines = posts.map((post) => {
    const url = absoluteUrl(defaultLocale, `/blog/${post.slug}`);
    return `- [${post.frontmatter.title}](${url}): ${post.frontmatter.description}`;
  });

  const body = [
    `# ${siteConfig.name}`,
    "",
    intro,
    "",
    "## Documentation",
    "",
    // The reference docs are a separate origin with its own llms.txt, and an
    // engine that only reads this file would never learn they exist.
    `- [mtmux documentation](${siteConfig.docsUrl}): Install, pairing, the sealed tunnel, self-hosting, the relay protocol and the web app reference.`,
    `- [Documentation index for LLMs](${siteConfig.docsUrl}/llms.txt): Every documentation page with its own description.`,
    // This file is an index; the companion carries the corpus, so an engine
    // that wants the text does not have to fetch twenty more documents.
    `- [Full text of every post](${siteConfig.url}/llms-full.txt): The complete body of every article on this site, in one file.`,
    "",
    "## Pages",
    "",
    ...pageLines,
    "",
    "## Blog",
    "",
    ...(postLines.length > 0 ? postLines : ["- (no posts published yet)"]),
    "",
  ].join("\n");

  return new Response(body, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
    },
  });
}
