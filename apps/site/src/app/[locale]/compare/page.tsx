import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";

import { JsonLd } from "@/components/json-ld";
import { CompareArticles } from "@/components/sections/compare/articles";
import { CompareHero } from "@/components/sections/compare/hero";
import { CompareLandscape } from "@/components/sections/compare/landscape";
import { CompareMatrix } from "@/components/sections/compare/matrix";
import { CompareWhenNot } from "@/components/sections/compare/when-not";
import type { Locale } from "@/i18n/locales";
import { buildMetadata } from "@/lib/seo";
import { breadcrumbSchema, graph, itemListSchema } from "@/lib/structured-data";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "compare" });

  return buildMetadata({
    locale: locale as Locale,
    path: "/compare",
    title: t("meta.title"),
    description: t("meta.description"),
  });
}

type ComparisonArticle = {
  id: string;
  title: string;
  summary: string;
};

export default async function ComparePage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);

  const t = await getTranslations({ locale, namespace: "compare" });
  const articles = t.raw("articles.items") as ComparisonArticle[];

  const trail = [
    { name: t("breadcrumb.home"), href: "/" },
    { name: t("breadcrumb.current"), href: "/compare" },
  ];

  const comparisons = articles.map((article) => ({
    name: `mtmux ${article.title}`,
    href: `/compare#${article.id}`,
    description: article.summary,
  }));

  return (
    <>
      <JsonLd
        json={graph(
          breadcrumbSchema(locale as Locale, trail),
          itemListSchema(locale as Locale, comparisons),
        )}
      />
      <CompareHero />
      <CompareMatrix />
      <CompareLandscape />
      <CompareArticles />
      <CompareWhenNot />
    </>
  );
}
