import { getTranslations } from "next-intl/server";
import type { ReactNode } from "react";

import { SectionHeading } from "@/components/primitives/section";
import { Link } from "@/i18n/navigation";

/**
 * The honesty section — the reason this page earns links instead of reading
 * like a sales pitch. Kept short and specific on purpose.
 */
export async function CompareWhenNot() {
  const t = await getTranslations("compare.whenNot");
  const items = t.raw("items") as string[];

  function linkRich(chunks: ReactNode) {
    return (
      <Link
        href="/docs"
        className="text-brand underline decoration-brand/40 underline-offset-3 hover:decoration-brand"
      >
        {chunks}
      </Link>
    );
  }

  return (
    <section className="border-t border-line-subtle">
      <div className="container-content max-w-3xl py-(--spacing-section)">
        <SectionHeading level={2} size="sm" title={t("title")} />
        <ul className="mt-6 grid gap-2.5 text-[1rem] leading-[1.75] text-text-muted">
          {items.map((item) => (
            <li key={item} className="flex gap-3">
              <span aria-hidden="true" className="text-signal-blocked">
                {"›"}
              </span>
              <span>{item}</span>
            </li>
          ))}
        </ul>
        <div className="mt-8 rounded-xl border border-line bg-surface-raised p-5">
          <p className="text-[1rem] leading-[1.75] text-text">
            {t.rich("note", { link: linkRich })}
          </p>
        </div>
      </div>
    </section>
  );
}
