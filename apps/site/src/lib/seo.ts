import type { Metadata } from "next";

import { siteConfig } from "@/config/site";
import {
  getLocaleDefinition,
  locales,
  defaultLocale,
  type Locale,
} from "@/i18n/locales";
import { getPathname } from "@/i18n/navigation";

/**
 * Metadata factory.
 *
 * Titles are passed through verbatim. We deliberately do NOT append a brand
 * suffix ("… | mtmux"): every character of a <title> is ranking real estate,
 * and a new domain gains nothing from spending 8 of them on a brand nobody
 * searches for yet. Brand attribution is carried by `og:site_name`, the
 * Organization JSON-LD and the visible logo instead.
 */

type BuildMetadataOptions = {
  locale: Locale;
  /** Locale-independent route, e.g. "/blog/tmux-cheat-sheet". */
  path: string;
  /** Keyword-first, ≤ 60 characters. No brand suffix. */
  title: string;
  /** ≤ 155 characters (enforced), and a standalone answer — AI engines quote it directly. */
  description: string;
  keywords?: readonly string[];
  type?: "website" | "article";
  publishedTime?: string;
  modifiedTime?: string;
  authors?: readonly string[];
  section?: string;
  tags?: readonly string[];
  /** Absolute or root-relative image URL. Defaults to the route's generated OG image. */
  image?: string;
  imageAlt?: string;
  noindex?: boolean;
};

/**
 * The description limit the type above documents. Seven pages had drifted past
 * it before this was checked rather than merely written down, and in every case
 * the clipped tail was the clause that distinguished the page from every other
 * page on the site. Trim the copy; do not raise the number.
 */
const MAX_DESCRIPTION_LENGTH = 155;

/** Absolute URL for a route in a given locale, honouring `localePrefix: 'as-needed'`. */
export function absoluteUrl(locale: Locale, path: string): string {
  const pathname = getPathname({ locale, href: path });
  return (
    `${siteConfig.url}${pathname === "/" ? "" : pathname}` || siteConfig.url
  );
}

/**
 * hreflang map. Every locale points at every other locale (bidirectional, as
 * Google requires) and `x-default` points at the unprefixed default locale.
 */
export function languageAlternates(path: string): Record<string, string> {
  const languages: Record<string, string> = {};
  for (const locale of locales) {
    languages[locale.code] = absoluteUrl(locale.code as Locale, path);
  }
  languages["x-default"] = absoluteUrl(defaultLocale, path);
  return languages;
}

export function buildMetadata({
  locale,
  path,
  title,
  description,
  keywords,
  type = "website",
  publishedTime,
  modifiedTime,
  authors,
  section,
  tags,
  image,
  imageAlt,
  noindex = false,
}: BuildMetadataOptions): Metadata {
  // Every page and post routes through here, so this fails the build rather
  // than shipping a description Google will cut off mid-sentence.
  if (description.length > MAX_DESCRIPTION_LENGTH) {
    throw new Error(
      `Meta description for "${path}" (${locale}) is ${description.length} characters; the limit is ${MAX_DESCRIPTION_LENGTH}:\n  ${description}`,
    );
  }

  const canonical = absoluteUrl(locale, path);
  const definition = getLocaleDefinition(locale);
  // Names the route's own generated card. That URL is a promise: the route
  // needs an `opengraph-image.tsx` beside its `page.tsx` or this points at a
  // 404 and the page shares as a bare grey link. `src/lib/og-page.tsx` renders
  // the shared one, so a new page's file is a handful of lines.
  const ogImage = image ?? `${canonical.replace(/\/$/, "")}/opengraph-image`;

  return {
    title,
    description,
    keywords: keywords ? [...keywords] : undefined,
    alternates: {
      canonical,
      languages: languageAlternates(path),
      types: {
        "application/rss+xml": `${siteConfig.url}/feed.xml`,
      },
    },
    openGraph: {
      type,
      title,
      description,
      url: canonical,
      siteName: siteConfig.name,
      locale: definition.ogLocale,
      alternateLocale: locales
        .filter((l) => l.code !== locale)
        .map((l) => l.ogLocale),
      images: [
        {
          url: ogImage,
          width: 1200,
          height: 630,
          alt: imageAlt ?? title,
        },
      ],
      ...(type === "article"
        ? {
            publishedTime,
            modifiedTime,
            authors: authors ? [...authors] : undefined,
            section,
            tags: tags ? [...tags] : undefined,
          }
        : {}),
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [ogImage],
    },
    robots: noindex
      ? // `noindex, follow`, not `noindex, nofollow`. The only pages that set
        // this are lists — thin tag pages — and their whole remaining value is
        // the links out of them. Telling a crawler to ignore those links throws
        // that away for nothing; keeping the page out of the index is all that
        // was ever wanted. `nofollow` is for links we distrust, which these are
        // not: they point at our own posts.
        { index: false, follow: true }
      : {
          index: true,
          follow: true,
          googleBot: {
            index: true,
            follow: true,
            "max-video-preview": -1,
            "max-image-preview": "large",
            "max-snippet": -1,
          },
        },
  };
}
