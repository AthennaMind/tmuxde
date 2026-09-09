"use client";

import { Check, Languages } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useTransition } from "react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { isMultilingual, locales } from "@/i18n/locales";
import { usePathname, useRouter } from "@/i18n/navigation";
import { cn } from "@/lib/utils";

/**
 * Renders nothing while the site is single-language, so shipping a second
 * locale is genuinely a one-line change in `src/i18n/locales.ts`.
 */
export function LocaleSwitcher({ className }: { className?: string }) {
  const t = useTranslations("common.locale");
  const active = useLocale();
  const router = useRouter();
  const pathname = usePathname();
  const [pending, startTransition] = useTransition();

  if (!isMultilingual) return null;

  function select(code: string) {
    startTransition(() => {
      // `pathname` is already locale-independent with dynamic segments
      // resolved, so the switcher lands on the same page in the new language.
      router.replace(pathname, { locale: code });
    });
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={pending}
        aria-label={t("label")}
        className={cn(
          "inline-flex h-8 items-center gap-1.5 rounded-lg border border-line bg-surface-panel px-2.5 font-mono text-[0.875rem] text-text-subtle transition-colors hover:border-line-strong hover:text-text-strong disabled:opacity-60",
          className,
        )}
      >
        <Languages aria-hidden="true" className="size-3.5" />
        <span className="uppercase">{active}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-48">
        <DropdownMenuLabel>{t("label")}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {locales.map((locale) => (
          <DropdownMenuItem
            key={locale.code}
            onClick={() => select(locale.code)}
            lang={locale.code}
            className="justify-between gap-4"
          >
            <span className="flex flex-col">
              <span>{locale.label}</span>
              <span className="text-xs text-text-faint">{locale.region}</span>
            </span>
            {locale.code === active ? (
              <Check aria-hidden="true" className="size-3.5 text-brand" />
            ) : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
