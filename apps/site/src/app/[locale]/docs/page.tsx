import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";

import { JsonLd } from "@/components/json-ld";
import { DOCS_QUICKSTART_COMMANDS } from "@/components/sections/docs/docs-quickstart";
import { DocsFooterNote } from "@/components/sections/docs/docs-footer-note";
import { DocsHero } from "@/components/sections/docs/docs-hero";
import { DocsInstall } from "@/components/sections/docs/docs-install";
import { DocsPointer } from "@/components/sections/docs/docs-pointer";
import { DocsQuickstart } from "@/components/sections/docs/docs-quickstart";
import { DocsToc } from "@/components/sections/docs/docs-toc";
import { siteConfig } from "@/config/site";
import type { Locale } from "@/i18n/locales";
import { buildMetadata } from "@/lib/seo";
import { breadcrumbSchema, graph, howToSchema } from "@/lib/structured-data";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "docs" });

  return buildMetadata({
    locale: locale as Locale,
    path: "/docs",
    title: t("meta.title"),
    description: t("meta.description"),
  });
}

export default async function DocsPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);

  const t = await getTranslations({ locale, namespace: "docs" });
  const steps = t.raw("quickstart.steps") as Array<{
    label: string;
    comment: string;
  }>;

  const schema = graph(
    breadcrumbSchema(locale as Locale, [
      { name: t("breadcrumb.home"), href: "/" },
      { name: t("breadcrumb.current"), href: "/docs" },
    ]),
    howToSchema({
      name: t("hero.title"),
      description: t("hero.lead"),
      totalTime: "PT2M",
      steps: steps.map((step, index) => ({
        name: step.label,
        text: `${step.label}. Run: ${DOCS_QUICKSTART_COMMANDS[index]}.`,
      })),
    }),
  );

  return (
    <>
      <JsonLd json={schema} />
      <DocsHero />
      <div className="container-content pb-(--spacing-section)">
        <div className="grid grid-cols-1 gap-10 lg:grid-cols-[13rem_minmax(0,1fr)] lg:gap-16">
          <DocsToc variant="sidebar" />
          <div className="min-w-0 space-y-16">
            <DocsInstall />
            <DocsQuickstart />
            {/* These three used to restate docs.mtmux.com/docs/{cli,
                self-hosting,troubleshooting} at a third of the length, on a
                page that then competed with them for the same queries. They
                keep their headings and ids so the table of contents is
                unchanged, and point at the version that is actually
                maintained. */}
            <DocsPointer
              id="cli-reference"
              title={t("cli.title")}
              href={`${siteConfig.docsUrl}/docs/cli`}
              linkLabel={t("cli.linkLabel")}
            >
              {t("cli.pointer")}
            </DocsPointer>
            <DocsPointer
              id="self-hosting"
              title={t("selfHosting.title")}
              href={`${siteConfig.docsUrl}/docs/self-hosting`}
              linkLabel={t("selfHosting.linkLabel")}
            >
              {t("selfHosting.pointer")}
            </DocsPointer>
            <DocsPointer
              id="troubleshooting"
              title={t("troubleshooting.title")}
              href={`${siteConfig.docsUrl}/docs/troubleshooting`}
              linkLabel={t("troubleshooting.linkLabel")}
            >
              {t("troubleshooting.pointer")}
            </DocsPointer>
            {/* docs.mtmux.com is a separate origin, so it gets no link equity
                from the site unless one is written by hand. This is the one
                place a reader of the quickstart is looking for more. */}
            <p className="border-t border-line-subtle pt-8 text-[1rem] text-text-subtle">
              {t.rich("fullDocs", {
                docsLink: (chunks) => (
                  <a
                    href={siteConfig.docsUrl}
                    className="text-brand underline decoration-brand/40 underline-offset-2 hover:decoration-brand"
                  >
                    {chunks}
                  </a>
                ),
              })}
            </p>
            <DocsFooterNote />
          </div>
        </div>
      </div>
    </>
  );
}
