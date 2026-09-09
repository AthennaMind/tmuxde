import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";

import { JsonLd } from "@/components/json-ld";
import { ClosingCta } from "@/components/sections/closing-cta";
import { Agents } from "@/components/sections/home/agents";
import { CompatStrip } from "@/components/sections/home/compat-strip";
import { Demo } from "@/components/sections/home/demo";
import { Faq } from "@/components/sections/home/faq";
import { Fidelity } from "@/components/sections/home/fidelity";
import { HomeHero } from "@/components/sections/home/hero";
import { PricingTeaser } from "@/components/sections/home/pricing-teaser";
import { Security } from "@/components/sections/home/security";
import { siteConfig } from "@/config/site";
import type { Locale } from "@/i18n/locales";
import { stripRichTags } from "@/lib/rich-links";
import { buildMetadata } from "@/lib/seo";
import {
  faqSchema,
  graph,
  howToSchema,
  softwareApplicationSchema,
  softwareId,
  webPageSchema,
} from "@/lib/structured-data";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "home" });

  return buildMetadata({
    locale: locale as Locale,
    path: "/",
    title: t("meta.title"),
    description: t("meta.description"),
  });
}

export default async function HomePage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);

  const t = await getTranslations({ locale, namespace: "home" });
  // Run through `stripRichTags` even though `home.faq` carries no tags today:
  // this is the third page to build `faqSchema` straight out of `t.raw`, and
  // the other two only grew a stripper after a tag had already shipped raw
  // into their structured data.
  const faqItems = (
    t.raw("faq.items") as Array<{
      question: string;
      answer: string;
    }>
  ).map((item) => ({
    question: stripRichTags(item.question),
    answer: stripRichTags(item.answer),
  }));

  // The HowTo is built from the *same* keys `Demo` renders, so the markup
  // cannot describe steps the page does not show. `ChapterRail` maps over all
  // five unconditionally, so every title and description is in the static HTML
  // whether or not playback ever starts — which is what makes this honest.
  // `stripRichTags` is not optional here: two of these descriptions carry
  // `<post>`, and raw markup inside JSON-LD is quoted verbatim by whatever
  // reads it.
  //
  // `t.raw`, not `t`: two of these descriptions carry `<post>`, and asking
  // next-intl to *format* a string whose tag handlers were not supplied throws
  // a FORMATTING_ERROR it logs on every render before falling back to the raw
  // value. The value is what we want, and `stripRichTags` is what removes the
  // tags, so ask for it directly.
  const chapterKeys = ["install", "pair", "attach", "move", "agent"] as const;
  const howToSteps = chapterKeys.map((key) => ({
    name: stripRichTags(t.raw(`demo.chapters.${key}.title`) as string),
    text: stripRichTags(t.raw(`demo.chapters.${key}.description`) as string),
  }));

  const featureList = (
    t.raw("fidelity.features") as Array<{ title: string }>
  ).map((feature) => stripRichTags(feature.title));

  return (
    <>
      <JsonLd
        json={graph(
          webPageSchema({
            locale: locale as Locale,
            path: "/",
            name: t("meta.title"),
            description: t("meta.description"),
            aboutId: softwareId,
            mainEntityId: softwareId,
          }),
          softwareApplicationSchema(t("meta.description"), { featureList }),
          howToSchema({
            // No `totalTime`: `/docs` already emits a HowTo claiming PT2M, and
            // two timed HowTos for the same product read as one contradicting
            // itself. This one is "what the demo shows", not "how long it takes".
            id: `${siteConfig.url}/#how-to-attach`,
            name: t("demo.title"),
            description: stripRichTags(t.raw("demo.description") as string),
            steps: howToSteps,
          }),
          faqSchema(faqItems),
        )}
      />
      <HomeHero />
      <CompatStrip />
      <Demo />
      <Fidelity />
      <Agents />
      <Security />
      <PricingTeaser />
      <Faq />
      <ClosingCta namespace="home.cta" showDocsLink />
    </>
  );
}
