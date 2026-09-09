import { getTranslations } from "next-intl/server";

import { AppLink } from "@/components/site/app-link";
import { CopyInstall } from "@/components/site/copy-install";
import { GithubLink } from "@/components/site/github-link";
import { LocaleSwitcher } from "@/components/site/locale-switcher";
import { Logo } from "@/components/site/logo";
import { MobileNav } from "@/components/site/mobile-nav";
import { NavLink } from "@/components/site/nav-link";
import { ThemeToggle } from "@/components/site/theme-toggle";
import { navigation } from "@/config/site";
import { Link } from "@/i18n/navigation";

export async function SiteHeader() {
  const t = await getTranslations("nav");

  return (
    <header className="sticky top-0 z-50 border-b border-line-subtle bg-surface-header backdrop-blur-xl backdrop-saturate-150">
      <div className="container-content flex h-16 items-center justify-between gap-4">
        <Link href="/" aria-label={t("home")} className="flex-none">
          <Logo />
        </Link>

        <nav
          aria-label={t("primary")}
          className="hidden items-center gap-0.5 md:flex"
        >
          {navigation.map((item) => (
            <NavLink key={item.key} href={item.href}>
              {t(item.key)}
            </NavLink>
          ))}
        </nav>

        <div className="flex flex-none items-center gap-2">
          <GithubLink className="hidden sm:grid" />
          <LocaleSwitcher className="hidden sm:inline-flex" />
          <ThemeToggle className="hidden sm:grid" />
          {/* From `sm` up, because below that the drawer carries it. This is
              also what closes the md–lg gap where the header had no call to
              action at all — promoting CopyInstall there instead would put
              190px of monospace in a 56px bar and wrap it. */}
          <AppLink label={t("openApp")} className="hidden sm:inline-flex" />
          <CopyInstall size="sm" className="hidden lg:inline-flex" />
          <MobileNav />
        </div>
      </div>
    </header>
  );
}
