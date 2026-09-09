import { evaluate } from "next-mdx-remote-client/rsc";
import rehypeAutolinkHeadings from "rehype-autolink-headings";
import rehypePrettyCode from "rehype-pretty-code";
import rehypeSlug from "rehype-slug";
import remarkGfm from "remark-gfm";

import { mdxComponents } from "@/components/mdx";

/**
 * Shiki emits both light and dark CSS variables per token; `globals.css`
 * chooses between them based on the active scheme, so code blocks follow the
 * theme toggle. `keepBackground: false` lets our surface token own the
 * background instead of the Shiki theme.
 */
const prettyCodeOptions = {
  theme: { light: "github-light", dark: "github-dark-dimmed" },
  keepBackground: false,
  defaultLang: "text",
} as const;

export async function renderMdx(source: string) {
  const { content, error } = await evaluate({
    source,
    options: {
      parseFrontmatter: false,
      mdxOptions: {
        remarkPlugins: [remarkGfm],
        rehypePlugins: [
          rehypeSlug,
          [
            rehypeAutolinkHeadings,
            {
              behavior: "append",
              properties: {
                "data-heading-anchor": "",
                "aria-hidden": "true",
                tabIndex: -1,
              },
              content: { type: "text", value: "#" },
            },
          ],
          [rehypePrettyCode, prettyCodeOptions],
        ],
      },
    },
    components: mdxComponents,
  });

  // A post that fails to compile must break the build loudly, not render blank.
  if (error) throw error;

  return content;
}

/**
 * Pulls question/answer pairs out of `<FAQItem q="…">` blocks in the raw MDX.
 *
 * Reading the source rather than hoisting state out of rendering guarantees
 * the FAQPage JSON-LD describes exactly the Q&A the reader can see — markup
 * that claims content the user cannot find is a structured-data violation.
 */
export function extractFaqEntries(
  source: string,
): Array<{ question: string; answer: string }> {
  const entries: Array<{ question: string; answer: string }> = [];
  const pattern =
    /<FAQItem\s+q=(?:"([^"]*)"|\{"([^"]*)"\})\s*>([\s\S]*?)<\/FAQItem>/g;

  for (const match of source.matchAll(pattern)) {
    const question = (match[1] ?? match[2] ?? "").trim();
    const answer = toPlainText(match[3]);

    if (question && answer) entries.push({ question, answer });
  }

  return entries;
}

/** Markup, code fences and links out; one line of readable prose in. */
function toPlainText(fragment: string): string {
  return fragment
    .replace(/^```[\s\S]*?^```$/gm, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Pulls `<Step title="…">` blocks out of the first `<Steps>` block in a post,
 * for `HowTo` structured data.
 *
 * Same contract as `extractFaqEntries` and for the same reason: it reads the
 * source the reader sees, so the markup cannot claim a procedure the page does
 * not actually show. Only the **first** `<Steps>` block counts — a post with
 * two procedures has two `HowTo`s, and picking one arbitrarily would describe a
 * sequence that never appears anywhere on the page.
 *
 * Be clear-eyed about the payoff: Google retired HowTo rich results for desktop
 * and mobile in 2023, so this earns no SERP treatment. It is here because
 * answer engines still extract step sequences when deciding what to quote, and
 * a procedure is the shape of content they quote most.
 */
export function extractStepEntries(
  source: string,
): Array<{ name: string; text: string }> {
  const block = /<Steps>([\s\S]*?)<\/Steps>/.exec(source);
  if (!block) return [];

  const entries: Array<{ name: string; text: string }> = [];
  const pattern =
    /<Step\s+title=(?:"([^"]*)"|\{"([^"]*)"\})\s*>([\s\S]*?)<\/Step>/g;

  for (const match of block[1].matchAll(pattern)) {
    const name = (match[1] ?? match[2] ?? "").trim();
    const text = toPlainText(match[3]);
    if (name && text) entries.push({ name, text });
  }

  return entries;
}
