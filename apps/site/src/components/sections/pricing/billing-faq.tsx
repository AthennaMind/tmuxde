import { getTranslations } from "next-intl/server";

import { HairlineCell, HairlineGrid } from "@/components/primitives/cards";
import { SectionHeading, Section } from "@/components/primitives/section";
import { TRIAL_DAYS } from "@/config/plans";
import { Link } from "@/i18n/navigation";
import { inlineLink } from "@/lib/rich-links";

type BillingFaqItem = { question: string; answer: string };

export async function PricingBillingFaq() {
  const t = await getTranslations("pricing.billingFaq");
  const items = t.raw("items") as BillingFaqItem[];

  return (
    <Section>
      <SectionHeading title={t("title")} level={2} size="sm" />
      <HairlineGrid minColumnWidth="20rem" className="mt-8 sm:mt-10">
        {items.map((item, index) => (
          <HairlineCell key={item.question}>
            <p className="mb-2 text-[1rem] text-text-strong">
              {item.question}
            </p>
            <p className="text-[0.875rem] leading-[1.7] text-text-muted">
              {t.rich(`items.${index}.answer`, {
                // Only the "without paying, without an account" answer carries
                // a <post> tag.
                post: inlineLink("/blog/tmux-in-browser"),
                // Only the trial answer carries {days}. Passed to every item
                // because ICU ignores an argument a message does not use, and
                // the alternative is a per-index branch that will rot the next
                // time someone reorders the list.
                days: TRIAL_DAYS,
              })}
            </p>
          </HairlineCell>
        ))}
      </HairlineGrid>
      <div className="mt-8 text-center">
        <Link
          href="/faq"
          className="text-[1rem] text-brand underline decoration-brand/40 underline-offset-3 hover:decoration-brand"
        >
          {t("moreLink")} →
        </Link>
      </div>
    </Section>
  );
}
