import { docData } from "@/lib/page-data";
import { source } from "@/lib/source";

export const dynamic = "force-static";

const BASE_URL = "https://docs.mtmux.com";

/**
 * Curated Markdown for LLM crawlers and answer engines at `/llms.txt`
 * (see https://llmstxt.org), matching the one mtmux.com serves.
 *
 * Every line is read from the Fumadocs page tree, so it lists exactly what is
 * published — adding an MDX file is the only step. The `title` and
 * `description` are the same frontmatter the pages themselves render, which is
 * the point: an answer engine that quotes this file quotes the docs.
 */
export function GET() {
  // Sort so the introduction leads and sibling pages stay grouped by section,
  // which is the order a reader would meet them in the sidebar.
  const pages = [...source.getPages()].sort((a, b) =>
    a.url === "/docs" ? -1 : b.url === "/docs" ? 1 : a.url.localeCompare(b.url),
  );

  const lines = pages.map((page) => {
    const { title, description } = docData(page.data);
    const url = `${BASE_URL}${page.url}`;
    return description
      ? `- [${title}](${url}): ${description}`
      : `- [${title}](${url})`;
  });

  const body = [
    "# mtmux docs",
    "",
    "Documentation for mtmux, the npm CLI that serves the tmux sessions you",
    "already run to any browser. The marketing site, blog and pricing live at",
    "https://mtmux.com (and its own https://mtmux.com/llms.txt).",
    "",
    `The full text of every page below is at ${BASE_URL}/llms-full.txt.`,
    "",
    "## Pages",
    "",
    ...lines,
    "",
  ].join("\n");

  return new Response(body, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
    },
  });
}
