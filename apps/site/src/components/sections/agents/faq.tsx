import { getTranslations } from "next-intl/server";
import type { ReactNode } from "react";

import { SectionHeading } from "@/components/primitives/section";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { inlineLink, stripRichTags } from "@/lib/rich-links";

export type FaqItem = {
  question: string;
  answer: string;
};

/**
 * Where each answer's one `<post>` tag points.
 *
 * ⚠️ Index-matched against `agents.faq.items` in `messages/en/agents.json`,
 * the same way the CLI table is. Reorder the items without reordering this and
 * the links point at the wrong post — silently, because a valid href to the
 * wrong page is not an error any build can see. The hrefs are literal strings
 * at the call site rather than assembled at runtime, because that is the only
 * form `src/lib/link-graph.ts` can read a marketing → blog edge out of.
 */
const POST_LINKS: Record<number, (chunks: ReactNode) => ReactNode> = {
  0: inlineLink("/blog/claude-code-notifications"),
  1: inlineLink("/blog/codex-cli-notifications"),
};

/** The tag list lives in `@/lib/rich-links` so all three JSON-LD pages share one. */
const toPlainText = stripRichTags;

/** Reads the FAQ entries so the page can build matching `faqSchema` JSON-LD. */
export async function getAgentsFaqItems(): Promise<FaqItem[]> {
  const t = await getTranslations("agents.faq");
  return (t.raw("items") as FaqItem[]).map((item) => ({
    question: toPlainText(item.question),
    answer: toPlainText(item.answer),
  }));
}

export async function AgentFaq({ items }: { items: FaqItem[] }) {
  const t = await getTranslations("agents.faq");

  return (
    <section className="border-t border-line-subtle">
      <div className="container-content max-w-3xl py-(--spacing-section)">
        <SectionHeading
          eyebrow={t("eyebrow")}
          eyebrowTone="agent"
          title={t("title")}
        />
        <Accordion className="mt-8" multiple>
          {items.map((item, index) => (
            <AccordionItem key={item.question} value={`faq-${index}`}>
              <AccordionTrigger className="py-4 text-[1rem] font-600 text-text-strong">
                {item.question}
              </AccordionTrigger>
              {/* A closed Base UI panel unmounts, which would leave these
                  answers — and the two blog links inside them — out of the
                  server-rendered HTML entirely. Keeping them mounted is what
                  makes them crawlable. */}
              <AccordionContent
                keepMounted
                className="text-[1rem] leading-[1.7] text-text-muted"
              >
                {POST_LINKS[index]
                  ? t.rich(`items.${index}.answer`, { post: POST_LINKS[index] })
                  : item.answer}
              </AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>
      </div>
    </section>
  );
}
