import { Check } from "lucide-react";
import { getTranslations } from "next-intl/server";

import { Section, SectionHeading } from "@/components/primitives/section";
import { PRICING } from "@/config/plans";
import { cn } from "@/lib/utils";
import { CopyInstall } from "@/components/site/copy-install";
import { Link } from "@/i18n/navigation";

type Tier = {
  name: string;
  note: string;
  features: string[];
  popular: boolean;
};

/**
 * Prices are read from `@/config/plans`, never typed into home.json, so the
 * teaser and /pricing can never quote two different numbers. That file mirrors
 * `packages/config/src/plans.ts`, which is what the broker enforces.
 */
const PRICE: Record<string, { amount: string; suffix: string }> = {
  Free: { amount: "$0", suffix: "" },
  Pro: { amount: `$${PRICING.pro.monthlyUsd}`, suffix: "/mo" },
};

export async function PricingTeaser() {
  const t = await getTranslations("home.pricing");
  const tiers = t.raw("tiers") as Tier[];

  return (
    <Section tone="base">
      <SectionHeading
        eyebrow={t("eyebrow")}
        title={t("title")}
        description={t("description")}
        level={2}
        size="sm"
        align="center"
        className="mx-auto mb-10 sm:mb-14"
      />

      <div className="mx-auto grid max-w-3xl grid-cols-[repeat(auto-fit,minmax(min(15.625rem,100%),1fr))] gap-3.5">
        {tiers.map((tier) => {
          const price = PRICE[tier.name] ?? { amount: "", suffix: "" };
          return (
            <div
              key={tier.name}
              className={cn(
                "surface-lift relative flex flex-col rounded-xl border p-7",
                tier.popular
                  ? "border-brand/45 ring-1 ring-brand/20"
                  : "border-line",
              )}
            >
              {tier.popular ? (
                <span className="absolute top-0 right-4 -translate-y-1/2 rounded-full bg-brand px-2.5 py-0.5 text-[0.75rem] font-700 text-brand-contrast">
                  {t("popularBadge")}
                </span>
              ) : null}
              <p
                className={cn(
                  "mb-3 text-[1rem]",
                  tier.popular ? "text-brand" : "text-text-subtle",
                )}
              >
                {tier.name}
              </p>
              <p className="font-display text-[2.375rem] leading-[1.1] tracking-[-0.05em] text-text-strong">
                {price.amount}
                {price.suffix ? (
                  <span className="font-mono text-[1.1875rem] text-text-faint">
                    {price.suffix}
                  </span>
                ) : null}
              </p>
              <p className="mt-1 mb-5 text-[0.875rem] text-text-faint">
                {tier.note}
              </p>
              <div className="grid gap-3 text-[1rem] text-text-muted">
                {tier.features.map((feature) => (
                  <span key={feature} className="flex items-start gap-2.5">
                    <Check
                      aria-hidden="true"
                      className="mt-0.5 size-4 shrink-0 text-brand"
                    />
                    {feature}
                  </span>
                ))}
                {/* Interpolated rather than written into home.json: a price
                    typed into a message file is a second source of truth that
                    nothing updates when the real one moves. */}
                {tier.popular ? (
                  <span className="flex items-start gap-2.5">
                    <Check
                      aria-hidden="true"
                      className="mt-0.5 size-4 shrink-0 text-brand"
                    />
                    {t("annual", { amount: PRICING.pro.yearlyUsd })}
                  </span>
                ) : null}
              </div>

              {/* A tier with no action is a dead end: both of these now lead
                  somewhere — the free one to the install, the paid one to the
                  page that sells it. */}
              <div className="mt-7 pt-5 border-t border-line-subtle">
                {tier.popular ? (
                  <Link
                    href="/pricing"
                    className="text-[1rem] text-brand underline decoration-line-strong underline-offset-4 transition-colors hover:decoration-brand"
                  >
                    {t("tierCta.pro")} →
                  </Link>
                ) : (
                  <CopyInstall size="sm" />
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div className="mt-6.5 text-center">
        <Link
          href="/pricing"
          className="text-[1rem] text-brand underline decoration-line-strong underline-offset-4 transition-colors hover:decoration-brand"
        >
          {t("fullComparison")} →
        </Link>
      </div>
    </Section>
  );
}
