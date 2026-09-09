"use client";

import { Check } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";

import { Section } from "@/components/primitives/section";
import { CopyInstall } from "@/components/site/copy-install";
import { buttonVariants } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { PRICING, TRIAL_DAYS } from "@/config/plans";
import { siteConfig } from "@/config/site";
import { cn } from "@/lib/utils";

/**
 * The two real plans, with a monthly/yearly toggle.
 *
 * Prices come from `@/config/plans` rather than pricing.json so a number can
 * only be wrong in one place. The yearly figure is shown as a monthly
 * equivalent because that is the comparison people are actually making, with
 * the annual total spelled out underneath rather than hidden.
 *
 * This is the only client island on the page: the toggle shares state with
 * the price it swaps.
 */
export function PricingTiers() {
  const t = useTranslations("pricing");
  const [yearly, setYearly] = useState(false);

  const freeFeatures = t.raw("tiers.free.features") as string[];
  const proFeatures = t.raw("tiers.pro.features") as string[];

  const monthly = PRICING.pro.monthlyUsd;
  const annual = PRICING.pro.yearlyUsd;
  // One decimal, trailing zero trimmed: $8.3, not $8.33 or $8.30.
  const perMonthOnYearly = (Math.round((annual / 12) * 10) / 10).toString();

  return (
    <Section bordered={false} innerClassName="pt-0">
      <div className="flex justify-center">
        <div className="inline-flex items-center gap-3 rounded-lg border border-line bg-surface-panel px-4 py-2.5">
          <span
            id="pricing-toggle-monthly"
            className={cn(
              "font-mono text-sm",
              yearly ? "text-text-faint" : "text-text-strong",
            )}
          >
            {t("toggle.monthly")}
          </span>
          <Switch
            checked={yearly}
            onCheckedChange={setYearly}
            aria-labelledby="pricing-toggle-monthly pricing-toggle-yearly"
          />
          <span
            id="pricing-toggle-yearly"
            className={cn(
              "font-mono text-sm",
              yearly ? "text-text-strong" : "text-text-faint",
            )}
          >
            {t("toggle.yearly")}{" "}
            <span className="text-brand">{t("toggle.yearlyDiscount")}</span>
          </span>
        </div>
      </div>

      <div className="mx-auto mt-9 grid max-w-3xl gap-3.5 sm:grid-cols-2">
        {/* Free */}
        <div className="flex flex-col rounded-xl border border-line bg-surface-raised p-6">
          <p className="text-[1rem] text-text-subtle">
            {t("tiers.free.name")}
          </p>
          <p className="mt-3.5 font-display text-[2.1875rem] leading-none tracking-[-0.05em] text-text-strong">
            $0
          </p>
          <p className="mt-2 text-[0.875rem] text-text-faint">
            {t("tiers.free.note")}
          </p>
          <TierFeatures features={freeFeatures} />
          <div className="mt-auto pt-6">
            <CopyInstall className="w-full justify-center" />
            {/* Installing *is* the truthful primary action on Free, so the
                account is offered underneath rather than in place of it. */}
            <p className="mt-3 text-center text-[0.875rem] leading-[1.6] text-text-faint">
              {t("tiers.free.accountNote")}
            </p>
          </div>
        </div>

        {/* Pro — popular */}
        <div className="relative flex flex-col rounded-xl border border-brand/50 bg-surface-raised p-6">
          <span className="absolute end-4.5 top-0 -translate-y-1/2 rounded-md bg-brand px-2.5 py-1 font-mono text-[0.75rem] font-700 text-brand-contrast">
            {t("tiers.pro.popularBadge")}
          </span>
          <p className="text-[1rem] text-brand">{t("tiers.pro.name")}</p>
          <p className="mt-3.5 flex items-baseline gap-1.5">
            <span className="font-display text-[2.1875rem] leading-none tracking-[-0.05em] text-text-strong">
              ${yearly ? perMonthOnYearly : monthly}
            </span>
            <span className="text-sm text-text-faint">
              {yearly
                ? t("tiers.pro.yearlySuffix")
                : t("tiers.pro.priceSuffix")}
            </span>
          </p>
          <p className="mt-2 text-[0.875rem] text-text-faint">
            {yearly ? `$${annual}/year · ` : ""}
            {t("tiers.pro.note")}
          </p>
          <TierFeatures features={proFeatures} />
          <div className="mt-auto pt-6">
            {/*
             * This button pointed at `/docs` and said "Upgrade" — a promise the
             * page could not keep in either direction. Billing runs in Dodo's
             * test mode, so a checkout link would lead somewhere that cannot
             * take money; and even in live mode checkout sits behind sign-in,
             * making "Upgrade" a two-hop claim. Creating the account is the
             * step that is true today and stays true afterwards.
             *
             * "Start your trial" would be wrong about the mechanism too: the
             * trial is not a button. `withTrial()` grants it on the first
             * refusal, which is what the line underneath describes.
             */}
            <a
              href={siteConfig.appSignUp}
              rel="noreferrer noopener"
              className={cn(
                buttonVariants({ size: "lg" }),
                "h-auto w-full justify-center px-5 py-3 text-[1rem]",
              )}
            >
              {t("tiers.pro.cta")}
            </a>
            <p className="mt-3 text-center text-[0.875rem] leading-[1.6] text-text-faint">
              {t("tiers.pro.trialNote", { days: TRIAL_DAYS })}
            </p>
          </div>
        </div>
      </div>
    </Section>
  );
}

function TierFeatures({ features }: { features: string[] }) {
  return (
    <ul className="mt-5.5 grid gap-2.5 text-[0.9375rem] text-text-muted">
      {features.map((feature) => (
        <li key={feature} className="flex gap-2.5">
          <Check
            aria-hidden="true"
            className="mt-0.5 size-3.5 shrink-0 text-brand"
          />
          <span>{feature}</span>
        </li>
      ))}
    </ul>
  );
}
