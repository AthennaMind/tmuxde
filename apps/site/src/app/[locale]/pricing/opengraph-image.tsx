import { siteConfig } from "@/config/site";
import { locales } from "@/i18n/locales";
import { OG_SIZE } from "@/lib/og";
import { renderPageOgCard } from "@/lib/og-page";

export const alt = siteConfig.name;
export const size = OG_SIZE;
export const contentType = "image/png";
export const dynamic = "force-static";

export function generateStaticParams() {
  return locales.map((locale) => ({ locale: locale.code }));
}

export default async function Image({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  return renderPageOgCard({
    locale,
    namespace: "pricing",
    path: "/pricing",
  });
}
