import { getTranslations } from "next-intl/server";

import { Section } from "@/components/primitives/section";
import { Link } from "@/i18n/navigation";

/**
 * The "attaches to what you already run" strip.
 *
 * The label is an `<h2>`, not a `<span>`: it is the heading of a section that
 * has content under it, and it was the only section on the page with none. The
 * `eyebrow` utility survives the promotion because `@utility` lands in
 * Tailwind's utilities layer, which beats the `h1–h4` rule in `@layer base` —
 * the same trick `site-footer.tsx` already relies on. The nine names are a real
 * list for the same reason: they were the page's one faked one.
 */
export async function CompatStrip() {
  const t = await getTranslations("home.compat");
  const items = t.raw("items") as string[];

  return (
    <Section
      tone="raised"
      className="border-b border-line-subtle"
      innerClassName="py-6"
    >
      <div className="flex flex-wrap items-center justify-center gap-x-8 gap-y-3.5">
        <h2 className="eyebrow text-text-faint">{t("label")}</h2>
        <ul className="flex list-none flex-wrap gap-2 font-mono text-[0.9375rem] text-text-subtle">
          {items.map((item) => (
            <li
              key={item}
              className="rounded-md border border-line-subtle bg-surface-base px-2.5 py-1"
            >
              {item}
            </li>
          ))}
        </ul>
        <Link
          href="/blog/tmux-tutorial"
          className="text-[0.875rem] text-text-faint underline decoration-line-strong underline-offset-4 transition-colors hover:text-brand hover:decoration-brand"
        >
          {t("moreLink")} →
        </Link>
      </div>
    </Section>
  );
}
