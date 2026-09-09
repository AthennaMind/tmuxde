import type { Metadata, Viewport } from "next";
import { hasLocale, NextIntlClientProvider } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";

import { fontVariables } from "@/app/fonts";
import { JsonLd } from "@/components/json-ld";
import { SiteFooter } from "@/components/site/site-footer";
import { SiteHeader } from "@/components/site/site-header";
import { SkipLink } from "@/components/site/skip-link";
import { siteConfig } from "@/config/site";
import { getLocaleDefinition, type Locale } from "@/i18n/locales";
import { routing } from "@/i18n/routing";
import {
  graph,
  organizationSchema,
  websiteSchema,
} from "@/lib/structured-data";
import { THEME_SCRIPT } from "@/lib/theme";

import "../globals.css";

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

export const viewport: Viewport = {
  // Both schemes ship. The browser chrome follows the one actually in use —
  // a single dark theme colour on a light page puts a black bar above white.
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f7f8f5" },
    { media: "(prefers-color-scheme: dark)", color: "#111312" },
  ],
  colorScheme: "dark light",
};

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "common" });

  return {
    metadataBase: new URL(siteConfig.url),
    applicationName: siteConfig.name,
    generator: undefined,
    referrer: "origin-when-cross-origin",
    creator: siteConfig.name,
    publisher: siteConfig.name,
    formatDetection: { telephone: false, address: false, email: false },
    icons: {
      icon: [
        { url: "/favicon.svg", type: "image/svg+xml" },
        { url: "/favicon.ico", sizes: "any" },
      ],
      apple: [{ url: "/apple-touch-icon.png", sizes: "180x180" }],
    },
    manifest: "/manifest.webmanifest",
    appleWebApp: {
      capable: true,
      title: siteConfig.name,
      statusBarStyle: "black-translucent",
    },
    other: {
      "msapplication-TileColor": "#0a0b0a",
    },
    title: {
      // Sub-pages set their own absolute titles; this is the fallback only.
      default: t("defaultTitle"),
      template: "%s",
    },
    description: t("defaultDescription"),
  };
}

export default async function LocaleLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) {
    notFound();
  }

  // Opts this subtree into static rendering.
  setRequestLocale(locale);

  const definition = getLocaleDefinition(locale);
  const t = await getTranslations({ locale, namespace: "common" });

  return (
    /*
      Served with `dark` on the element: it is the canonical mtmux look, and
      shipping the *majority* scheme in the static HTML is what keeps the
      pre-paint script from having to repaint most visits. `ThemeScript`
      removes it before first paint for anyone who chose light or whose OS
      asks for it, so there is no flash either way — and `suppressHydration
      Warning` is required because that script legitimately edits the class
      React is about to hydrate against.
    */
    <html
      lang={locale}
      dir={definition.dir}
      suppressHydrationWarning
      className={`dark ${fontVariables}`}
    >
      <head>
        {/* A constant string from lib/theme.ts — no interpolation reaches it.
            It has to run before first paint, so it cannot be a module. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
        <JsonLd
          json={graph(organizationSchema(), websiteSchema(locale as Locale))}
        />
      </head>
      {/*
        Browser extensions commonly stamp attributes onto <body> before React
        hydrates (password managers, ad blockers, shopping helpers), which React
        reports as a hydration mismatch even though the markup we render is
        identical. Suppressing it here covers that one element only — it does
        not hide genuine mismatches in the tree below.
      */}
      <body
        suppressHydrationWarning
        className="min-h-dvh bg-surface-base text-text antialiased"
      >
        <NextIntlClientProvider>
          <SkipLink label={t("skipToContent")} />
          <div className="relative flex min-h-dvh flex-col">
            <SiteHeader />
            <main id="content" className="flex-1">
              {children}
            </main>
            <SiteFooter />
          </div>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
