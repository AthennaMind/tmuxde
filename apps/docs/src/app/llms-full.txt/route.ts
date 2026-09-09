import { docData } from "@/lib/page-data";
import { source } from "@/lib/source";

export const dynamic = "force-static";

const BASE_URL = "https://docs.mtmux.com";

/**
 * The whole documentation set as one Markdown document, for answer engines that
 * would rather read the corpus than crawl 30 URLs (see https://llmstxt.org).
 *
 * `/llms.txt` is the index — titles, descriptions and links. This is the text.
 * The body of each page comes from `getText("processed")`, which
 * `source.config.ts` enables, so this file is always the same prose the site
 * renders: there is no second copy of the docs to keep in sync, and a page
 * added to `content/docs` appears here without anyone remembering to add it.
 */
export async function GET() {
  // Introduction first, then sibling pages grouped by section — the order a
  // reader would meet them in the sidebar.
  const pages = [...source.getPages()].sort((a, b) =>
    a.url === "/docs" ? -1 : b.url === "/docs" ? 1 : a.url.localeCompare(b.url),
  );

  const sections = await Promise.all(
    pages.map(async (page) => {
      const data = docData(page.data);
      const header = [
        `# ${data.title}`,
        "",
        `Source: ${BASE_URL}${page.url}`,
        ...(data.description ? ["", data.description] : []),
        "",
      ];
      return [...header, (await data.getText("processed")).trim(), ""].join(
        "\n",
      );
    }),
  );

  const body = [
    "# mtmux docs — full text",
    "",
    "Every page of the mtmux documentation, in full. mtmux is an npm CLI that",
    "serves the tmux sessions you already run to any browser. The index version",
    `of this file is at ${BASE_URL}/llms.txt; the marketing site, blog and`,
    "pricing live at https://mtmux.com.",
    "",
    "---",
    "",
    ...sections,
  ].join("\n");

  return new Response(body, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
