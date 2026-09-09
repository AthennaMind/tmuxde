import { getTranslations } from "next-intl/server";

import { Section, SectionHeading } from "@/components/primitives/section";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Link } from "@/i18n/navigation";
import { inlineLink } from "@/lib/rich-links";

type FaqItem = { question: string; answer: string };

/**
 * The blog href for each answer that carries a `<post>` tag, keyed by index.
 *
 * Literal strings at module scope, deliberately. `src/lib/link-graph.ts` finds
 * marketing → blog edges by grepping component source, so an href assembled
 * from the loop index (`/blog/${slug}`) would render fine and be invisible to
 * the build gate — an edge that silently does not exist is worse than no edge.
 */
const ANSWER_LINKS: Record<number, string> = {
  6: "/blog/tmate-alternative",
};

export async function Faq() {
  const t = await getTranslations("home.faq");
  const items = t.raw("items") as FaqItem[];

  return (
    <Section tone="raised">
      <div className="mx-auto max-w-[46rem]">
        <SectionHeading
          eyebrow={t("eyebrow")}
          title={t("title")}
          level={2}
          size="sm"
          align="center"
          className="mb-8 max-w-none sm:mb-11"
        />

        <Accordion
          defaultValue={[0]}
          className="surface-lift overflow-hidden rounded-xl border border-line px-6 sm:px-7"
        >
          {items.map((item, index) => (
            <AccordionItem
              key={item.question}
              value={index}
              className="border-line-subtle last:border-b-0"
            >
              <AccordionTrigger className="gap-3.5 py-5 text-start font-mono text-[1.0625rem] text-text-strong hover:no-underline hover:text-brand">
                <span
                  aria-hidden="true"
                  className="text-[0.8125rem] text-brand"
                >
                  ▸
                </span>
                <span className="flex-1">{item.question}</span>
              </AccordionTrigger>
              {/* A closed Base UI panel unmounts. With `defaultValue={[0]}`
                  that left five of these six answers out of the server-rendered
                  HTML entirely — while the FAQPage JSON-LD on `page.tsx` went on
                  describing all six. Structured data claiming content a crawler
                  cannot find in the page is the exact violation the schema
                  builders in `lib/structured-data.ts` exist to avoid. Keeping
                  the panels mounted is what makes the markup true; they still
                  render `hidden`, so nothing changes visually. */}
              <AccordionContent keepMounted>
                <p className="max-w-[66ch] ps-7.5 pb-1 text-[1.0625rem] leading-[1.8] text-text-muted">
                  {t.rich(`items.${index}.answer`, {
                    post: inlineLink(ANSWER_LINKS[index] ?? "/blog"),
                  })}
                </p>
              </AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>

        <div className="mt-5.5 text-center">
          <Link
            href="/faq"
            className="text-[1rem] text-brand underline decoration-line-strong underline-offset-4 transition-colors hover:decoration-brand"
          >
            {t("moreLink")} →
          </Link>
        </div>
      </div>
    </Section>
  );
}
