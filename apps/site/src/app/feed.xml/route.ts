import { siteConfig } from "@/config/site";
import { defaultLocale } from "@/i18n/locales";
import { loadMessages } from "@/i18n/messages";
import { getAllPosts } from "@/lib/blog";
import { absoluteUrl } from "@/lib/seo";

export const dynamic = "force-static";

type MessageTree = Record<string, unknown>;

/**
 * Reads one string out of the message tree, the same way `/llms.txt` does.
 *
 * The channel title and description used to be English literals in this file,
 * which is how the feed ended up advertising "agent-aware notifications" — a
 * product that does not exist and never will. Copy that describes the product
 * belongs in `messages/`, where the site's own rules about it apply.
 */
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

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export async function GET() {
  const messages = (await loadMessages(defaultLocale)) as MessageTree;
  const posts = (await getAllPosts(defaultLocale)).slice(0, 20);
  const feedUrl = `${siteConfig.url}/feed.xml`;
  const channelTitle =
    readString(messages, ["blog", "feed", "title"]) ?? siteConfig.name;
  const channelDescription =
    readString(messages, ["blog", "feed", "description"]) ??
    readString(messages, ["blog", "meta", "description"]) ??
    "";
  const updated =
    posts[0]?.frontmatter.date ?? new Date().toISOString().slice(0, 10);

  const items = posts
    .map((post) => {
      const url = absoluteUrl(defaultLocale, `/blog/${post.slug}`);
      return `    <item>
      <title>${escapeXml(post.frontmatter.title)}</title>
      <link>${url}</link>
      <guid isPermaLink="true">${url}</guid>
      <description>${escapeXml(post.frontmatter.description)}</description>
      <pubDate>${new Date(post.frontmatter.date).toUTCString()}</pubDate>
      <category>${escapeXml(post.frontmatter.category)}</category>
    </item>`;
    })
    .join("\n");

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${escapeXml(channelTitle)}</title>
    <link>${siteConfig.url}</link>
    <description>${escapeXml(channelDescription)}</description>
    <language>${defaultLocale}</language>
    <lastBuildDate>${new Date(updated).toUTCString()}</lastBuildDate>
    <atom:link href="${feedUrl}" rel="self" type="application/rss+xml" />
${items}
  </channel>
</rss>`;

  return new Response(xml, {
    headers: { "Content-Type": "application/xml; charset=utf-8" },
  });
}
