import { getTranslations } from "next-intl/server";

import { LocaleSwitcher } from "@/components/site/locale-switcher";
import { LogoMark } from "@/components/site/logo";
import { footerNavigation, siteConfig } from "@/config/site";
import { Link } from "@/i18n/navigation";

const COLUMNS = [
  { key: "product", items: footerNavigation.product },
  { key: "resources", items: footerNavigation.resources },
  { key: "compare", items: footerNavigation.compare },
  { key: "company", items: footerNavigation.company },
] as const;

export async function SiteFooter() {
  const t = await getTranslations("footer");
  const year = new Date().getFullYear();

  return (
    <footer className="border-t border-line-subtle bg-surface-raised">
      <div className="container-content grid gap-10 py-14 md:grid-cols-[minmax(0,1.4fr)_repeat(4,minmax(0,1fr))] md:gap-8">
        <div className="max-w-72">
          <Link href="/" className="inline-flex items-center gap-2.5">
            <LogoMark />
            <span className="font-display text-[1.125rem] font-600 tracking-[-0.04em] text-text-strong">
              mtmux
            </span>
          </Link>
          <p className="mt-4 text-sm leading-relaxed text-text-subtle">
            {t("tagline")}
          </p>
          {/* Was a glowing "relay operational" light, which implied a status
              page we do not run. A version and a licence are both checkable. */}
          <p className="mt-5 inline-flex items-center gap-2 rounded-md border border-line px-2.5 py-1.5 font-mono text-[0.875rem] text-text-muted">
            <span className="text-text-strong">v{siteConfig.version}</span>
            <span aria-hidden="true" className="text-text-faint">
              ·
            </span>
            {t("status")}
          </p>
          <div className="mt-5 flex items-center gap-2 sm:hidden">
            <LocaleSwitcher />
          </div>
        </div>

        {COLUMNS.map((column) => (
          <nav key={column.key} aria-label={t(`headings.${column.key}`)}>
            <h2 className="eyebrow font-display text-xs text-text-faint">
              {t(`headings.${column.key}`)}
            </h2>
            <ul className="mt-4 grid gap-2.5">
              {column.items.map((item) => (
                <li key={item.key}>
                  {"external" in item && item.external ? (
                    <a
                      href={item.href}
                      target={
                        item.href.startsWith("mailto:") ? undefined : "_blank"
                      }
                      rel="noreferrer noopener"
                      className="text-sm text-text-muted transition-colors hover:text-brand"
                    >
                      {t(`links.${item.key}`)}
                    </a>
                  ) : (
                    <Link
                      href={item.href}
                      className="text-sm text-text-muted transition-colors hover:text-brand"
                    >
                      {t(`links.${item.key}`)}
                    </Link>
                  )}
                </li>
              ))}
            </ul>
          </nav>
        ))}
      </div>

      <div className="container-content flex flex-wrap items-center justify-between gap-3 border-t border-line-subtle py-6">
        <p className="text-[0.875rem] text-text-faint">
          {t("copyright", { year })}
        </p>
        <p className="font-mono text-[0.875rem] text-text-faint">
          v{siteConfig.version} · {siteConfig.requirements}
        </p>
      </div>
    </footer>
  );
}
