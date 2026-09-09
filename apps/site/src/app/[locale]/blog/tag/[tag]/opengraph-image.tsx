import { getTranslations } from "next-intl/server";

import { siteConfig } from "@/config/site";
import { locales } from "@/i18n/locales";
import { getAllTags, tagSlug } from "@/lib/blog";
import { OG_SIZE } from "@/lib/og";
import { renderOgCard } from "@/lib/og-page";

export const alt = siteConfig.name;
export const size = OG_SIZE;
export const contentType = "image/png";
export const dynamic = "force-static";

export async function generateStaticParams() {
  const params: Array<{ locale: string; tag: string }> = [];
  for (const locale of locales) {
    for (const { tag } of await getAllTags(locale.code)) {
      params.push({ locale: locale.code, tag: tagSlug(tag) });
    }
  }
  return params;
}

export default async function Image({
  params,
}: {
  params: Promise<{ locale: string; tag: string }>;
}) {
  const { locale, tag } = await params;
  const tags = await getAllTags(locale);
  const label = tags.find((entry) => tagSlug(entry.tag) === tag)?.tag;

  const t = await getTranslations({ locale, namespace: "blog" });

  // A tag only exists as long as a post carries it, and a static param can
  // outlive its source file between builds — fall back to the blog's own card
  // rather than throwing, as `blog/[slug]/opengraph-image.tsx` does.
  return label
    ? renderOgCard({
        title: t("tagMeta.title", { tag: label }),
        description: t("tagMeta.description", { tag: label }),
        path: `/blog/tag/${tag}`,
      })
    : renderOgCard({
        title: t("meta.title"),
        description: t("meta.description"),
        path: "/blog",
      });
}
