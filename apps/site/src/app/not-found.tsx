import { NextIntlClientProvider } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";

import { fontVariables } from "@/app/fonts";
import { LogoMark } from "@/components/site/logo";
import { defaultLocale, getLocaleDefinition } from "@/i18n/locales";
import { Link } from "@/i18n/navigation";
import { THEME_SCRIPT } from "@/lib/theme";

import "./globals.css";

/**
 * The site's 404, and the only page that renders its own document.
 *
 * A URL that matches no locale segment never reaches `[locale]/layout.tsx`,
 * and the root layout above this file is a deliberate pass-through — so
 * without an `<html>` here Next served a 404 body with no `<html>`, no
 * `<body>` and no `lang`, which is invalid markup and gives a screen reader no
 * language to announce it in. The shell is duplicated rather than shared
 * because the one in `[locale]` is built from a locale this route does not
 * have: there is no segment to read it from.
 *
 * Not-found responses carry `noindex` from Next itself, so nothing here asks to
 * be indexed. The links are for a person who took a wrong turn.
 */
export default async function NotFound() {
  // No request locale to resolve, so the default is chosen explicitly. It is
  // served unprefixed (`localePrefix: "as-needed"`), which is what makes the
  // links below plain `/docs` and `/blog`.
  const locale = defaultLocale;
  // Same reason as every page: without it the route renders on demand and the
  // 404 loses its static HTML.
  setRequestLocale(locale);
  const t = await getTranslations({ locale, namespace: "common" });

  const links = [
    { href: "/", label: t("notFound.cta") },
    { href: "/docs", label: t("notFound.docs") },
    { href: "/blog", label: t("notFound.blog") },
  ];

  return (
    <html
      lang={locale}
      dir={getLocaleDefinition(locale).dir}
      suppressHydrationWarning
      className={`dark ${fontVariables}`}
    >
      {/* The pass-through root layout exports no metadata, so nothing else
          would give this document a <title>. Next supplies the `noindex`. */}
      <head>
        <title>{t("notFound.title")}</title>
        {/* This document builds its own shell, so it needs its own copy of the
            pre-paint theme script — without it a light-mode visitor gets a
            dark 404 in the middle of an otherwise light session. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className="min-h-dvh bg-surface-base text-text antialiased">
        {/* Only so `Link` can read a locale; this document has no client copy. */}
        <NextIntlClientProvider locale={locale}>
          <main className="container-content flex min-h-dvh flex-col justify-center py-24">
            <Link href="/" className="inline-flex w-fit items-center gap-2.5">
              <LogoMark />
              <span className="font-display text-[1.125rem] font-600 tracking-[-0.04em] text-text-strong">
                mtmux
              </span>
            </Link>

            <p className="eyebrow mt-12 font-mono text-xs text-text-faint">
              404
            </p>
            <h1 className="mt-3 text-[clamp(1.8125rem,3.6vw,2.625rem)] leading-[1.04]">
              {t("notFound.title")}
            </h1>
            <p className="mt-4 max-w-[52ch] text-[1.125rem] leading-[1.7] text-text-muted">
              {t("notFound.description")}
            </p>

            <nav
              aria-label={t("notFound.title")}
              className="mt-9 flex flex-wrap gap-x-7 gap-y-3 font-mono text-[0.9375rem]"
            >
              {links.map((link) => (
                <Link
                  key={link.href}
                  href={link.href}
                  className="text-brand hover:underline"
                >
                  {link.label}
                </Link>
              ))}
            </nav>
          </main>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
