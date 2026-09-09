export const SITE_URL = "https://docs.mtmux.com";
export const SITE_NAME = "mtmux docs";

/** The `@id` mtmux.com mints for the product. Referenced, never restated. */
export const SOFTWARE_ID = "https://mtmux.com/#software";

type Json = Record<string, unknown>;

/**
 * `BreadcrumbList` for a docs page.
 *
 * Built from the page's own URL segments and the titles the sidebar already
 * shows, so the trail in the markup is the trail on the screen. Google renders
 * this in place of the raw URL in results, which on a site where every URL
 * starts `docs.mtmux.com/docs/` is the difference between "Docs › Agents ›
 * Claude Code" and a truncated path.
 */
export function breadcrumbSchema(
  crumbs: { name: string; url: string }[],
): Json {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: crumbs.map((crumb, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name: crumb.name,
      item: `${SITE_URL}${crumb.url}`,
    })),
  };
}

/**
 * `TechArticle` for a docs page.
 *
 * `TechArticle` rather than `Article`: these pages are dependency-carrying
 * reference material, and the type lets `proficiencyLevel` and `dependencies`
 * say so. `about` points at the product entity mtmux.com owns instead of
 * describing the product again here — two machine-readable descriptions that
 * disagree are worse than one, which is the same reasoning the root layout's
 * JSON-LD already records.
 */
export function techArticleSchema({
  title,
  description,
  url,
  lastModified,
}: {
  title: string;
  description?: string;
  url: string;
  lastModified?: Date;
}): Json {
  return {
    "@context": "https://schema.org",
    "@type": "TechArticle",
    "@id": `${SITE_URL}${url}#article`,
    headline: title,
    ...(description ? { description } : {}),
    url: `${SITE_URL}${url}`,
    mainEntityOfPage: { "@type": "WebPage", "@id": `${SITE_URL}${url}` },
    inLanguage: "en",
    isPartOf: {
      "@type": "WebSite",
      "@id": `${SITE_URL}/#website`,
      name: SITE_NAME,
      url: SITE_URL,
    },
    about: { "@id": SOFTWARE_ID },
    // Only emitted when git actually knows: an invented date is worse than none.
    ...(lastModified
      ? { dateModified: lastModified.toISOString().slice(0, 10) }
      : {}),
    publisher: {
      "@type": "Organization",
      name: "mtmux",
      url: "https://mtmux.com",
    },
  };
}

/** Strips the Markdown a plain-text `acceptedAnswer` must not contain. */
function toPlainText(markdown: string): string {
  return (
    markdown
      .replace(/```[\s\S]*?```/g, "")
      .replace(/<[^>]+>/g, "")
      .replace(/!\[[^\]]*]\([^)]*\)/g, "")
      .replace(/\[([^\]]+)]\([^)]*\)/g, "$1")
      // `remark-heading` appends its slug to every heading in the processed
      // Markdown — `### "Node 22+ required" [#node-22-required]`. Left in, it
      // shipped inside the `Question.name` of all 25 FAQ entries.
      .replace(/\s*\[#[^\]]*]\s*/g, " ")
      .replace(/[*_`>]/g, "")
      .replace(/\s+/g, " ")
      .trim()
  );
}

export interface FaqEntry {
  question: string;
  answer: string;
}

/**
 * Reads `### heading` + the prose under it out of a page's own Markdown.
 *
 * Deriving the markup from the rendered source, rather than from a
 * hand-maintained list in frontmatter, is the whole point: `FAQPage` markup
 * that promises a question the page does not contain is a manual action, and a
 * duplicated list drifts the first time someone edits only the prose.
 *
 * A heading whose section has no plain prose (only a code block, only a table)
 * is skipped rather than given an empty answer.
 */
export function extractFaqEntries(markdown: string, limit = 30): FaqEntry[] {
  const entries: FaqEntry[] = [];
  const sections = markdown.split(/^###\s+/m).slice(1);

  for (const section of sections) {
    const newline = section.indexOf("\n");
    if (newline === -1) continue;
    const question = toPlainText(section.slice(0, newline));
    // Stop at the next heading of any level. Splitting on `###` alone let the
    // last entry before an `##` swallow that whole section — the final
    // question's answer was the page's "Next steps" list.
    const body = section.slice(newline).split(/^#{1,6}\s/m)[0] ?? "";
    const answer = toPlainText(body).slice(0, 900);
    if (!question || answer.length < 40) continue;
    entries.push({ question, answer });
    if (entries.length >= limit) break;
  }

  return entries;
}

export function faqSchema(entries: FaqEntry[]): Json | undefined {
  if (entries.length === 0) return undefined;
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: entries.map((entry) => ({
      "@type": "Question",
      name: entry.question,
      acceptedAnswer: { "@type": "Answer", text: entry.answer },
    })),
  };
}

export interface StepEntry {
  name: string;
  text: string;
}

/**
 * Reads `<Step title="…">` blocks out of a page's own Markdown.
 *
 * Same contract as the FAQ extractor: the steps in the markup are exactly the
 * steps the reader sees, because both come from the same source. Google retired
 * the HowTo rich result, so the payoff here is answer-engine extraction rather
 * than a SERP treatment — worth the twenty lines, not worth hand-maintaining.
 */
export function extractStepEntries(markdown: string): StepEntry[] {
  const steps: StepEntry[] = [];
  const pattern = /<Step\s+title="([^"]+)"\s*>([\s\S]*?)<\/Step>/g;

  for (const match of markdown.matchAll(pattern)) {
    const name = match[1]?.trim();
    const text = toPlainText(match[2] ?? "").slice(0, 500);
    if (!name) continue;
    steps.push({ name, text: text || name });
  }

  return steps;
}

export function howToSchema({
  title,
  description,
  url,
  steps,
}: {
  title: string;
  description?: string;
  url: string;
  steps: StepEntry[];
}): Json | undefined {
  if (steps.length < 2) return undefined;
  return {
    "@context": "https://schema.org",
    "@type": "HowTo",
    name: title,
    ...(description ? { description } : {}),
    step: steps.map((step, index) => ({
      "@type": "HowToStep",
      position: index + 1,
      name: step.name,
      text: step.text,
      url: `${SITE_URL}${url}`,
    })),
  };
}
