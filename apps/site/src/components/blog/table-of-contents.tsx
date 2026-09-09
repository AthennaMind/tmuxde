"use client";

import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";

import type { TocEntry } from "@/lib/blog";
import { cn } from "@/lib/utils";

/**
 * Sticky table of contents that highlights the section currently in view.
 *
 * Uses IntersectionObserver rather than scroll maths so it stays cheap, and
 * degrades to a plain anchor list if the API is unavailable.
 */
export function TableOfContents({ entries }: { entries: TocEntry[] }) {
  const t = useTranslations("blog");
  const [activeId, setActiveId] = useState<string | null>(null);

  useEffect(() => {
    if (entries.length === 0 || typeof IntersectionObserver === "undefined")
      return;

    const observer = new IntersectionObserver(
      (records) => {
        const visible = records
          .filter((record) => record.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);

        if (visible[0]) setActiveId(visible[0].target.id);
      },
      // Focus on the band just under the sticky header.
      { rootMargin: "-88px 0px -70% 0px", threshold: 0 },
    );

    for (const entry of entries) {
      const element = document.getElementById(entry.id);
      if (element) observer.observe(element);
    }

    return () => observer.disconnect();
  }, [entries]);

  if (entries.length < 2) return null;

  return (
    <nav aria-labelledby="toc-heading" className="text-[0.9375rem]">
      <p id="toc-heading" className="eyebrow mb-3 text-text-faint">
        {t("onThisPage")}
      </p>
      <ul className="grid gap-1.5 border-s border-line-subtle ps-4">
        {entries.map((entry) => (
          <li key={entry.id} className={cn(entry.depth === 3 && "ps-3")}>
            <a
              href={`#${entry.id}`}
              aria-current={activeId === entry.id ? "location" : undefined}
              className={cn(
                "block leading-snug transition-colors",
                activeId === entry.id
                  ? "text-brand"
                  : "text-text-subtle hover:text-text-strong",
              )}
            >
              {entry.text}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
