import { docData } from "@/lib/page-data";
import { source } from "@/lib/source";
import { renderDocsOgCard } from "@/lib/og-card";

/**
 * One Open Graph card per docs page, prerendered at build time.
 *
 * This is a route handler rather than the tidier `opengraph-image.tsx`
 * metadata-file convention, and not by preference: the docs pages live under an
 * optional catch-all, and Next refuses any segment after a catch-all —
 * "Optional catch-all must be the last part of the URL in route
 * /docs/[[...slug]]/opengraph-image". A route handler *is* the leaf, so it is
 * allowed. `generateMetadata` in `docs/[[...slug]]/page.tsx` therefore names
 * these URLs explicitly.
 *
 * The path mirrors the docs slug: `/og` is the introduction, `/og/pairing` is
 * `/docs/pairing`, `/og/agents/claude-code` is `/docs/agents/claude-code`.
 */
export const dynamic = "force-static";

export function generateStaticParams() {
  return source.generateParams();
}

/**
 * The section a page sits in, drawn as the card's eyebrow.
 *
 * Read from the section's own index page rather than from the page tree, for
 * the reason recorded in `docs/[[...slug]]/page.tsx`: a folder node's `name` is
 * a `ReactNode` and did not come back as a string here.
 */
function sectionFor(slug: string[] | undefined): string | undefined {
  if (!slug || slug.length < 2) return undefined;
  const section = source.getPage(slug.slice(0, 1));
  return section ? docData(section.data).title : undefined;
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ slug?: string[] }> },
) {
  const { slug } = await params;
  const page = source.getPage(slug);

  // A slug with no page gets the site-level card rather than a 404 image: a
  // broken `og:image` renders as a grey box in every chat client, which is a
  // worse outcome than a slightly generic one.
  if (!page) {
    return renderDocsOgCard({
      title: "mtmux docs",
      description:
        "Install the mtmux CLI, pair a device, and understand the sealed tunnel.",
      path: "/docs",
    });
  }

  const data = docData(page.data);

  return renderDocsOgCard({
    title: data.title,
    description: data.description,
    path: page.url,
    eyebrow: sectionFor(slug),
  });
}
