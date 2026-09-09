"use client";

import { Check, Copy } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";

import { siteConfig } from "@/config/site";
import { cn } from "@/lib/utils";

type CopyInstallProps = {
  /** `lg` is the hero treatment; `sm` sits in the header. */
  size?: "sm" | "md" | "lg";
  /**
   * `solid` fills with the brand colour. Used where this is the page's primary
   * action and has to out-rank the outline button beside it — a bordered box
   * next to a bordered box makes the visitor choose between two equals, and
   * the one that installs the product should not be the quieter of the two.
   */
  variant?: "outline" | "solid";
  className?: string;
};

/**
 * The site's single call to action: the install command itself.
 *
 * There is no sign-up, so the shortest path to value is a command the visitor
 * can paste. Clicking anywhere on the block copies it.
 */
export function CopyInstall({
  size = "md",
  variant = "outline",
  className,
}: CopyInstallProps) {
  const t = useTranslations("common");
  const [copied, setCopied] = useState(false);
  const timeout = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(timeout.current), []);

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(siteConfig.install);
    } catch {
      // Clipboard can be blocked (insecure origin, denied permission).
      // The command is visible either way, so fail silently.
      return;
    }
    setCopied(true);
    clearTimeout(timeout.current);
    timeout.current = setTimeout(() => setCopied(false), 2000);
  }, []);

  return (
    <button
      type="button"
      onClick={copy}
      data-copied={copied || undefined}
      aria-label={t("copyInstallLabel", { command: siteConfig.install })}
      className={cn(
        "group inline-flex items-center gap-3 rounded-lg border font-mono transition-[background-color,border-color,box-shadow,transform] duration-200",
        variant === "outline" &&
          "border-line bg-surface-panel text-text hover:border-line-strong hover:bg-surface-raised",
        variant === "solid" &&
          "border-transparent bg-brand text-brand-contrast shadow-lift hover:-translate-y-0.5 hover:bg-brand-hover",
        size === "sm" && "gap-2 px-2.5 py-1.5 text-[0.875rem]",
        size === "md" && "px-3.5 py-2.5 text-[0.9375rem]",
        size === "lg" && "px-5 py-3.5 text-[1.0625rem] font-500",
        className,
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "select-none-prompt",
          variant === "solid" ? "opacity-60" : "text-brand",
        )}
      >
        $
      </span>
      <span className="tracking-[-0.01em] whitespace-nowrap">
        {siteConfig.install}
      </span>
      <span
        className={cn(
          "relative ms-1 grid place-items-center transition-colors",
          variant === "solid"
            ? "text-brand-contrast opacity-70 group-hover:opacity-100"
            : "text-text-subtle group-hover:text-brand",
          size === "sm" ? "size-3.5" : "size-4",
        )}
      >
        <Copy
          aria-hidden="true"
          className={cn(
            "absolute size-full transition-all duration-150",
            copied && "scale-50 opacity-0",
          )}
        />
        <Check
          aria-hidden="true"
          className={cn(
            "absolute size-full transition-all duration-150",
            variant === "solid" ? "text-brand-contrast" : "text-brand",
            copied ? "scale-100 opacity-100" : "scale-50 opacity-0",
          )}
        />
      </span>
      <span aria-live="polite" className="sr-only">
        {copied ? t("copied") : ""}
      </span>
    </button>
  );
}
