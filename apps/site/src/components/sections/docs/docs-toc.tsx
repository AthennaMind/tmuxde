import { getTranslations } from "next-intl/server";

import { cn } from "@/lib/utils";

/** Shared anchor list — same ids as the section headings below. */
export const DOCS_TOC_SECTIONS = [
  { id: "install", key: "install" },
  { id: "quickstart", key: "quickstart" },
  { id: "cli-reference", key: "cli" },
  { id: "self-hosting", key: "selfHosting" },
  { id: "troubleshooting", key: "troubleshooting" },
] as const;

/**
 * In-page navigation for the docs page.
 *
 * `row` renders a wrapped inline list under the hero, visible below the
 * `lg` breakpoint. `sidebar` renders the sticky aside used at `lg` and up.
 * Both read from the same anchor list so the two never drift apart.
 */
export async function DocsToc({ variant }: { variant: "row" | "sidebar" }) {
  const t = await getTranslations("docs.nav");

  if (variant === "sidebar") {
    return (
      <aside className="hidden lg:block">
        <nav aria-label={t("label")} className="sticky top-24 self-start">
          <p className="eyebrow mb-3 text-text-faint">{t("label")}</p>
          <ul className="space-y-0.5 border-s border-line-subtle">
            {DOCS_TOC_SECTIONS.map((section) => (
              <li key={section.id}>
                <a
                  href={`#${section.id}`}
                  className="-ms-px block border-s-2 border-transparent px-4 py-1.5 text-[0.875rem] text-text-subtle transition-colors hover:border-line-strong hover:text-text"
                >
                  {t(section.key)}
                </a>
              </li>
            ))}
          </ul>
        </nav>
      </aside>
    );
  }

  return (
    <nav
      aria-label={t("label")}
      className={cn("mt-6 flex flex-wrap gap-x-5 gap-y-2 lg:hidden")}
    >
      {DOCS_TOC_SECTIONS.map((section) => (
        <a
          key={section.id}
          href={`#${section.id}`}
          className="border-b border-line-subtle pb-0.5 text-sm text-text-subtle transition-colors hover:text-text"
        >
          {t(section.key)}
        </a>
      ))}
    </nav>
  );
}
