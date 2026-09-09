import { ArrowUpRight } from "lucide-react";
import { getTranslations } from "next-intl/server";

import { HairlineCell, HairlineGrid } from "@/components/primitives/cards";
import { Link } from "@/i18n/navigation";
import { Section, SectionHeading } from "@/components/primitives/section";
import { TRIAL_DAYS } from "@/config/plans";
import { siteConfig } from "@/config/site";

/**
 * "Why sign in at all?", answered where the question is actually asked.
 *
 * It sits between the tier cards and the comparison table on purpose: the
 * limits that provoke the question are still on screen. It is deliberately not
 * a `/accounts` page — `docs.mtmux.com/docs/accounts` already covers this, and
 * restating a docs page here would put two URLs on a brand-only keyword with
 * the shorter one on the stronger domain.
 *
 * Every claim below was traced to code, not to a roadmap. Things it must never
 * say, because they are false: "sign in for more bandwidth" (backwards —
 * anonymous relay is unmetered, signing in is what *introduces* the meter),
 * "3 trusted devices" as a live gate (`devicesPerServer` is displayed but
 * nothing enforces it), session or tunnel time limits, or sharing from the
 * browser.
 */
export async function PricingAccounts() {
  const t = await getTranslations("pricing.accounts");

  const items = ["join", "dashboard", "machines", "trial"] as const;

  return (
    <Section tone="raised">
      <SectionHeading
        eyebrow={t("eyebrow")}
        title={t("title")}
        description={t("description")}
        level={2}
        size="sm"
        className="mb-10"
      />

      <HairlineGrid minColumnWidth="15rem">
        {items.map((key) => (
          <HairlineCell key={key}>
            {/* `days` goes to the title as well as the body — the trial card
                carries the placeholder in both, and a title rendered without
                it ships a literal "{days}" to the page. */}
            <p className="font-sans text-[1rem] font-600 tracking-[-0.01em] text-text-strong">
              {t(`items.${key}.title`, { days: TRIAL_DAYS })}
            </p>
            <p className="mt-2 text-[0.875rem] leading-[1.65] text-text-muted">
              {t(`items.${key}.body`, { days: TRIAL_DAYS })}
            </p>
          </HairlineCell>
        ))}
      </HairlineGrid>

      {/*
       * The counterweight, and it is not decoration. "Accounts are optional
       * forever" is an invariant of the product, and a section arguing for
       * accounts on a site that promises no account five times has to say
       * which promise still holds.
       */}
      <p className="mt-6 max-w-2xl text-[0.9375rem] leading-[1.7] text-text-muted">
        {t("unchanged")}
      </p>

      <div className="mt-7 flex flex-wrap items-center gap-x-6 gap-y-3 text-[0.9375rem]">
        <a
          href={siteConfig.appSignUp}
          rel="noreferrer noopener"
          className="inline-flex items-center gap-1 text-brand underline decoration-line-strong underline-offset-4 transition-colors hover:decoration-brand"
        >
          {t("cta.create")}
          <ArrowUpRight aria-hidden="true" className="size-3.5" />
        </a>
        <a
          href={siteConfig.appSignIn}
          rel="noreferrer noopener"
          className="inline-flex items-center gap-1 text-text-muted transition-colors hover:text-text-strong"
        >
          {t("cta.signIn")}
          <ArrowUpRight aria-hidden="true" className="size-3.5" />
        </a>
        {/*
         * The site's own /docs, not `siteConfig.docsUrl`.
         *
         * `docs.mtmux.com` has no DNS record and no nginx vhost — `mtmux-docs`
         * runs on 24102 and nothing routes to it — so every absolute docsUrl
         * link on this site is currently a dead end. That is pre-existing and
         * needs a DNS record to fix; adding a fifth broken link to it is not
         * the way to celebrate it. Switch this back once the host resolves.
         */}
        <Link
          href="/docs"
          className="inline-flex items-center gap-1 text-text-muted transition-colors hover:text-text-strong"
        >
          {t("cta.docs")}
        </Link>
      </div>
    </Section>
  );
}
