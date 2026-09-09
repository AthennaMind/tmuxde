import type { ReactNode } from "react";

import { inlineLinkClassName } from "@/lib/rich-links";

/**
 * A section that used to be a full re-statement of a docs.mtmux.com page, and
 * is now a signpost to it.
 *
 * The CLI table, the self-hosting recipe and the troubleshooting grid each had
 * a longer, better-maintained twin on the docs site — two URLs competing for
 * the same query, with the shorter one sitting on the stronger domain. That is
 * the self-inflicted split `docs/seo-strategy.md` warns about, and we were
 * doing it to ourselves three times on one page.
 *
 * The heading and its `id` are kept deliberately: `docs-toc.tsx` anchors to
 * them, so shrinking the sections costs the table of contents nothing. What
 * changes is that the space is spent on a link instead of on a worse copy.
 */
export function DocsPointer({
  id,
  title,
  children,
  href,
  linkLabel,
}: {
  id: string;
  title: string;
  children: ReactNode;
  href: string;
  linkLabel: string;
}) {
  return (
    <section id={id}>
      <h2 className="mb-4 text-[clamp(1.3125rem,2.5vw,1.8125rem)] leading-[1.06]">
        {title}
      </h2>
      <p className="mb-4 max-w-[62ch] text-[1rem] leading-[1.75] text-text-muted">
        {children}
      </p>
      <a
        href={href}
        target="_blank"
        rel="noreferrer noopener"
        className={inlineLinkClassName}
      >
        {linkLabel} →
      </a>
    </section>
  );
}
