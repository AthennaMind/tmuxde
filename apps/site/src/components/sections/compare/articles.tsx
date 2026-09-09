import { getTranslations } from "next-intl/server";

import { Eyebrow, Section } from "@/components/primitives/section";

type ComparisonArticle = {
  id: string;
  title: string;
  summary: string;
  paragraphs: string[];
};

/**
 * The four honest comparisons. Anchor ids match the footer's `/compare#…`
 * links exactly, so a click from anywhere on the site lands on the right
 * card instead of the top of the page.
 */
export async function CompareArticles() {
  const t = await getTranslations("compare.articles");
  const items = t.raw("items") as ComparisonArticle[];

  return (
    <Section tone="raised">
      <Eyebrow>{t("eyebrow")}</Eyebrow>
      <div className="mt-5 grid grid-cols-1 gap-3.5 sm:grid-cols-2">
        {items.map((item) => (
          <article
            key={item.id}
            id={item.id}
            className="scroll-mt-24 rounded-xl border border-line-subtle bg-surface-base p-6"
          >
            <h2 className="text-[1.375rem] leading-[1.12]">{item.title}</h2>
            {item.paragraphs.map((paragraph) => (
              <p
                key={paragraph}
                className="mt-3.5 text-[1rem] leading-[1.75] text-text-muted"
              >
                {paragraph}
              </p>
            ))}
          </article>
        ))}
      </div>
    </Section>
  );
}
