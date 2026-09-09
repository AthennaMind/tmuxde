"use client";

import { Monitor, Moon, Sun } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useSyncExternalStore } from "react";

import {
  THEME_CHOICES,
  THEME_EVENT,
  THEME_STORAGE_KEY,
  type ThemeChoice,
} from "@/lib/theme";
import { cn } from "@/lib/utils";

const ICONS = {
  system: Monitor,
  light: Sun,
  dark: Moon,
} as const;

/**
 * The document element is the store.
 *
 * The pre-paint script has already written the visitor's choice to
 * `data-theme` before React exists, so reading it back is both the cheapest
 * and the only correct source — component state would start out disagreeing
 * with the page it is describing. `useSyncExternalStore` is what lets a
 * client component read a mutable DOM value without a setState-in-effect.
 */
function subscribe(onChange: () => void) {
  window.addEventListener(THEME_EVENT, onChange);
  const query = window.matchMedia("(prefers-color-scheme: dark)");
  query.addEventListener("change", onChange);
  // Another tab switching theme should move this one too.
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(THEME_EVENT, onChange);
    query.removeEventListener("change", onChange);
    window.removeEventListener("storage", onChange);
  };
}

function readChoice(): ThemeChoice {
  const value = document.documentElement.dataset.theme;
  return THEME_CHOICES.includes(value as ThemeChoice)
    ? (value as ThemeChoice)
    : "system";
}

/** The server renders the neutral glyph; the client corrects it on hydration. */
function serverChoice(): ThemeChoice {
  return "system";
}

function apply(choice: ThemeChoice) {
  const dark =
    choice === "dark" ||
    (choice === "system" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
  document.documentElement.dataset.theme = choice;
  try {
    if (choice === "system") localStorage.removeItem(THEME_STORAGE_KEY);
    else localStorage.setItem(THEME_STORAGE_KEY, choice);
  } catch {
    // Private mode, or storage denied. The choice still applies to this page.
  }
  window.dispatchEvent(new Event(THEME_EVENT));
}

/**
 * Cycles system → light → dark → system.
 *
 * A cycle rather than a two-state switch because "system" is a real answer for
 * this audience: a developer whose OS is on a sunset schedule wants the site to
 * follow it, and a plain sun/moon switch silently opts them out of that forever
 * on the first click.
 */
export function ThemeToggle({ className }: { className?: string }) {
  const t = useTranslations("common.theme");
  const choice = useSyncExternalStore(subscribe, readChoice, serverChoice);

  const next = useCallback(() => {
    const index = THEME_CHOICES.indexOf(choice);
    apply(THEME_CHOICES[(index + 1) % THEME_CHOICES.length]!);
  }, [choice]);

  const Icon = ICONS[choice];

  return (
    <button
      type="button"
      onClick={next}
      aria-label={t("cycle", { current: t(choice) })}
      title={t(choice)}
      className={cn(
        "grid size-9 place-items-center rounded-lg border border-line bg-surface-raised text-text-subtle transition-colors",
        "hover:border-line-strong hover:bg-surface-panel hover:text-text-strong",
        className,
      )}
    >
      <Icon aria-hidden="true" className="size-4" />
      <span aria-live="polite" className="sr-only">
        {t(choice)}
      </span>
    </button>
  );
}
