import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";

import { JsonLd } from "@/components/json-ld";
import { PricingAccounts } from "@/components/sections/pricing/accounts";
import { PricingBillingFaq } from "@/components/sections/pricing/billing-faq";
import { PricingComparisonTable } from "@/components/sections/pricing/comparison-table";
import { PricingHero } from "@/components/sections/pricing/hero";
import { PricingTeam } from "@/components/sections/pricing/team";
import { PricingTiers } from "@/components/sections/pricing/tiers";
import type { Locale } from "@/i18n/locales";
import { buildMetadata } from "@/lib/seo";
import {
  breadcrumbSchema,
  graph,
  softwareApplicationSchema,
} from "@/lib/structured-data";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "pricing" });

  return buildMetadata({
    locale: locale as Locale,
    path: "/pricing",
    title: t("meta.title"),
    description: t("meta.description"),
  });
}

export default async function PricingPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);

  const t = await getTranslations({ locale, namespace: "pricing" });

  const schema = graph(
    softwareApplicationSchema(t("meta.description")),
    breadcrumbSchema(locale as Locale, [
      { name: t("breadcrumb.home"), href: "/" },
      { name: t("breadcrumb.current"), href: "/pricing" },
    ]),
  );

  return (
    <>
      <JsonLd json={schema} />
      <PricingHero />
      <PricingTiers />
      {/* Between the cards and the table: the limits that raise the question
          are still on screen when it gets answered. */}
      <PricingAccounts />
      <PricingComparisonTable />
      <PricingTeam />
      <PricingBillingFaq />
    </>
  );
}
