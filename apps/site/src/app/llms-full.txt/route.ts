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
 * Strips the MDX component layer so the body reads as plain Markdown.
 *
 * An answer engine reading this file has no `<Callout>` or `<FAQItem>`
 * component to render. Leaving the tags in makes the prose noisier without
 * adding meaning, but the *content* inside them is often the most quotable part
 * of a post — so the tags go and the children stay. Fenced code blocks are kept
 * verbatim: a tmux command is the answer, not decoration.
 */
function toMarkdown(body: string): string {
  return body
    .replace(/<FAQItem\s+q="([^"]*)"\s*>/g, "\n**$1**\n")
    .replace(/<Step\s+title="([^"]*)"\s*>/g, "\n**$1**\n")
    .replace(/<Callout[^>]*title="([^"]*)"[^>]*>/g, "\n**$1**\n")
    .replace(/<\/?(FAQ|FAQItem|Steps|Step|Callout|Figure)[^>]*>/g, "")
    .replace(/<TerminalDemo[^>]*>/g, "\n```text")
    .replace(/<\/TerminalDemo>/g, "```\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * `/llms-full.txt` — every post's full text in one file.
 *
 * `/llms.txt` is an index: titles, descriptions and URLs, which tells a crawler
 * what exists but requires it to fetch sixteen more documents to learn
 * anything. This is the companion the spec describes for the case where the
 * whole corpus is small enough to hand over at once, which ours is. The two are
 * generated from the same source, so neither can go stale against the site.
 */
export async function GET() {
  const messages = (await loadMessages(defaultLocale)) as MessageTree;
  const posts = await getAllPosts(defaultLocale);

  const intro =
    readString(messages, ["home", "meta", "description"]) ??
    readString(messages, ["common", "defaultDescription"]) ??
    siteConfig.name;

  const routeLines = staticRoutes.map(
    (route) => `- ${absoluteUrl(defaultLocale, route.href)}`,
  );

  const sections = posts.map((post) => {
    const url = absoluteUrl(defaultLocale, `/blog/${post.slug}`);
    const { frontmatter } = post;
    return [
      `## ${frontmatter.title}`,
      "",
      `Source: ${url}`,
      `Published: ${frontmatter.date}${frontmatter.updated ? ` · Updated: ${frontmatter.updated}` : ""}`,
      `Category: ${frontmatter.category} · Tags: ${frontmatter.tags.join(", ")}`,
      "",
      `> ${frontmatter.description}`,
      "",
      toMarkdown(post.body),
      "",
    ].join("\n");
  });

  const body = [
    `# ${siteConfig.name} — full text`,
    "",
    intro,
    "",
    `mtmux serves the tmux sessions you already run to any browser over an end-to-end encrypted tunnel. It sends no notifications of any kind. Install with \`${siteConfig.install}\`.`,
    "",
    `Reference documentation lives at ${siteConfig.docsUrl} and has its own llms.txt.`,
    "",
    "## Pages",
    "",
    ...routeLines,
    "",
    "---",
    "",
    ...sections,
  ].join("\n");

  return new Response(body, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
