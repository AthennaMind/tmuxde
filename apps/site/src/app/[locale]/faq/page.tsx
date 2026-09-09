import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import type { ReactNode } from "react";

import { JsonLd } from "@/components/json-ld";
import { Cmd, HairlineCell, HairlineGrid } from "@/components/primitives/cards";
import { Eyebrow, Section } from "@/components/primitives/section";
import { Link } from "@/i18n/navigation";
import type { Locale } from "@/i18n/locales";
import { inlineLink, inlineLinkClassName, stripRichTags } from "@/lib/rich-links";
import { buildMetadata } from "@/lib/seo";
import { breadcrumbSchema, faqSchema, graph } from "@/lib/structured-data";

type FaqItem = { question: string; answer: string };
type FaqCategory = { label: string; items: FaqItem[] };

const CATEGORY_ORDER = [
  "basics",
  "phone",
  "agents",
  "security",
  "money",
] as const;

/** Internal link destination for the one `<link>` tag each of these categories' copy uses. */
const CATEGORY_LINK_HREF: Partial<
  Record<(typeof CATEGORY_ORDER)[number], string>
> = {
  security: "/security",
  money: "/pricing",
};

/**
 * Where each answer's one `<post>` tag points, keyed `category.index`.
 *
 * ⚠️ Index-matched against the `items` arrays in `messages/en/faq.json`, the
 * same way the CLI table is. Insert an item without updating this map and the
 * links below it point at the wrong post — silently, because a valid href to
 * the wrong page is not an error anyone's build can see.
 */
const POST_LINK_HREF: Record<string, string> = {
  "basics.0": "/blog/tmux-attach-session",
  "basics.3": "/blog/install-tmux",
  "basics.5": "/blog/tmux-commands",
  "phone.0": "/blog/tmux-from-phone",
  "agents.4": "/blog/tmux-notifications",
  "security.5": "/blog/tmux-in-browser",
};

/** The tag list lives in `@/lib/rich-links` so all three JSON-LD pages share one. */
const toPlainText = stripRichTags;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "faq" });

  return buildMetadata({
    locale: locale as Locale,
    path: "/faq",
    title: t("meta.title"),
    description: t("meta.description"),
  });
}

export default async function FaqPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);

  const t = await getTranslations({ locale, namespace: "faq" });
  const categories = t.raw("categories") as Record<string, FaqCategory>;

  const allQuestions = CATEGORY_ORDER.flatMap((key) =>
    categories[key].items.map((item) => ({
      question: toPlainText(item.question),
      answer: toPlainText(item.answer),
    })),
  );

  const schema = graph(
    faqSchema(allQuestions),
    breadcrumbSchema(locale as Locale, [
      { name: t("breadcrumb.home"), href: "/" },
      { name: t("breadcrumb.current"), href: "/faq" },
    ]),
  );

  return (
    <>
      <JsonLd json={schema} />

      <header className="container-content pt-(--spacing-section) pb-8 sm:pb-10">
        <Eyebrow>{t("hero.eyebrow")}</Eyebrow>
        <h1 className="max-w-[22ch] text-[clamp(1.75rem,3.8vw,2.8125rem)] leading-[1]">
          {t("hero.title")}
        </h1>
        <p className="mt-4 max-w-[56ch] text-[1.125rem] leading-[1.72] text-text-muted">
          {t.rich("hero.lead", {
            mailLink: (chunks: ReactNode) => (
              <a href="mailto:hey@mtmux.com" className={inlineLinkClassName}>
                {chunks}
              </a>
            ),
          })}
        </p>
      </header>

      <Section bordered={false} innerClassName="pt-0">
        <nav aria-label={t("jumpNav.label")} className="flex flex-wrap gap-2">
          {CATEGORY_ORDER.map((key) => (
            <a
              key={key}
              href={`#${key}`}
              className="rounded-full border border-line bg-surface-panel px-3.5 py-1.5 font-mono text-[0.875rem] text-text-muted transition-colors hover:border-line-strong hover:text-text-strong"
            >
              {categories[key].label}
            </a>
          ))}
        </nav>

        <div className="mt-10 grid gap-11 sm:mt-12 sm:gap-14">
          {CATEGORY_ORDER.map((key) => (
            <div key={key} id={key} className="scroll-mt-24">
              <h2 className="mb-4.5 font-mono text-[0.875rem] font-500 tracking-[0.14em] text-text-faint uppercase">
                {categories[key].label}
              </h2>
              <HairlineGrid minColumnWidth="20rem">
                {categories[key].items.map((item, index) => (
                  <HairlineCell key={item.question}>
                    <h3 className="mb-2 text-[1.0625rem] font-600 text-text-strong">
                      {item.question}
                    </h3>
                    <p className="text-[0.9375rem] leading-[1.75] text-text-muted">
                      {t.rich(`categories.${key}.items.${index}.answer`, {
                        cmd: (chunks: ReactNode) => <Cmd>{chunks}</Cmd>,
                        link: (chunks: ReactNode) => (
                          <Link href={CATEGORY_LINK_HREF[key] ?? "/"}>
                            {chunks}
                          </Link>
                        ),
                        post: inlineLink(
                          POST_LINK_HREF[`${key}.${index}`] ?? "/blog",
                        ),
                      })}
                    </p>
                  </HairlineCell>
                ))}
              </HairlineGrid>
            </div>
          ))}
        </div>
      </Section>
    </>
  );
}
