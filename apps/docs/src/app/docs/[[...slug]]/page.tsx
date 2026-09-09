import type { Metadata } from "next";
import { notFound } from "next/navigation";
import {
  DocsPage,
  DocsBody,
  DocsTitle,
  DocsDescription,
} from "fumadocs-ui/page";

import { getMDXComponents } from "@/mdx-components";
import { docData } from "@/lib/page-data";
import { source } from "@/lib/source";
import {
  breadcrumbSchema,
  extractFaqEntries,
  extractStepEntries,
  faqSchema,
  howToSchema,
  techArticleSchema,
} from "@/lib/structured-data";

/**
 * The trail from the introduction down to this page, as plain strings.
 *
 * Built from the slug's own prefixes rather than from `getBreadcrumbItems`.
 * That helper walks the page tree and returns a folder's `name` as a
 * `ReactNode`, which in this tree came back as something other than a string —
 * so the middle crumb was silently dropped and `/docs/agents/claude-code`
 * shipped a two-item trail with the section missing. Looking each ancestor up
 * as a page instead uses the title the section index actually renders, and a
 * missing ancestor is skipped rather than guessed at.
 */
function crumbsFor(slug: string[] | undefined, title: string, url: string) {
  const trail = [{ name: "Docs", url: "/docs" }];

  for (let depth = 1; depth < (slug?.length ?? 0); depth++) {
    const ancestor = source.getPage(slug!.slice(0, depth));
    if (!ancestor) continue;
    trail.push({ name: docData(ancestor.data).title, url: ancestor.url });
  }

  if (url !== "/docs") trail.push({ name: title, url });
  return trail;
}

export default async function Page({
  params,
}: {
  params: Promise<{ slug?: string[] }>;
}) {
  const { slug } = await params;
  const page = source.getPage(slug);

  if (!page) notFound();

  const data = docData(page.data);
  const Mdx = data.body;
  const markdown = await data.getText("processed");

  /**
   * Per-page JSON-LD. The article node is on every page; the FAQ and HowTo
   * nodes appear only where the page's own Markdown actually contains the
   * shape, so nothing here can claim content the reader cannot see.
   */
  const schemas: Record<string, unknown>[] = [
    breadcrumbSchema(crumbsFor(slug, data.title, page.url)),
    techArticleSchema({
      title: data.title,
      description: data.description,
      url: page.url,
      lastModified: data.lastModified,
    }),
  ];

  if (page.url === "/docs/troubleshooting") {
    const faq = faqSchema(extractFaqEntries(markdown));
    if (faq) schemas.push(faq);
  }

  const steps = extractStepEntries(markdown);
  if (steps.length >= 2) {
    const howTo = howToSchema({
      title: data.title,
      description: data.description,
      url: page.url,
      steps,
    });
    if (howTo) schemas.push(howTo);
  }

  return (
    <DocsPage toc={data.toc ?? []} lastUpdate={data.lastModified}>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(schemas) }}
      />
      <DocsTitle>{data.title}</DocsTitle>
      <DocsDescription>{data.description}</DocsDescription>
      <DocsBody>
        <Mdx components={getMDXComponents()} />
      </DocsBody>
    </DocsPage>
  );
}

export async function generateStaticParams() {
  return source.generateParams();
}

/**
 * Every MDX file already carries a `title` and a `description` in its
 * frontmatter — until this existed, nothing read them, so all 22 pages shipped
 * the root layout's fallback title and description.
 *
 * `alternates.canonical` and `openGraph.url` are the page's own path rather
 * than the site root: relative values here are resolved against the
 * `metadataBase` on the root layout, which keeps the domain in one place.
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug?: string[] }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const page = source.getPage(slug);

  // A slug outside the page tree renders `notFound()` above; returning empty
  // metadata leaves the 404 with the layout's defaults and nothing invented.
  if (!page) return {};

  const data = docData(page.data);
  const title = data.title;
  const description = data.description;

  /**
   * This page's own card, from `app/og/[[...slug]]/route.tsx`.
   *
   * All 22 pages used to name `/opengraph-image`, one static picture reading
   * "tmux in your browser." — so the protocol reference and the troubleshooting
   * page shared a preview that said nothing about either. The path mirrors the
   * docs slug, so `/docs/agents/claude-code` cards at `/og/agents/claude-code`.
   */
  const ogImage = {
    url: `/og${page.url.slice("/docs".length)}`,
    width: 1200,
    height: 630,
    alt: title,
  };

  return {
    title,
    description,
    alternates: { canonical: page.url },
    // Next replaces the parent's `openGraph` wholesale rather than merging into
    // it, so `siteName` and `locale` are restated here or they are lost.
    openGraph: {
      type: "article",
      url: page.url,
      siteName: "mtmux docs",
      locale: "en_US",
      title,
      description,
      images: [ogImage],
      ...(data.lastModified
        ? { modifiedTime: data.lastModified.toISOString() }
        : {}),
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [ogImage],
    },
  };
}
