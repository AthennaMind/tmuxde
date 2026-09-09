import type { ReactNode } from "react";

import { Eyebrow } from "@/components/primitives/section";
import { cn } from "@/lib/utils";

/**
 * Shared layout for /privacy and /terms.
 *
 * Purely presentational: the page component owns translation lookups (and
 * builds any rich text, e.g. mailto links or inline commands) and hands this
 * component a flat list of already-rendered sections. Adding a third legal
 * page later is just a new `page.tsx` that repeats that pattern.
 */
export type LegalSection = {
  id: string;
  heading: string;
  content: ReactNode;
};

export function LegalPage({
  eyebrow,
  title,
  lastUpdated,
  sections,
}: {
  eyebrow: string;
  title: string;
  lastUpdated: string;
  sections: LegalSection[];
}) {
  return (
    <div className="container-prose py-(--spacing-section)">
      <Eyebrow>{eyebrow}</Eyebrow>
      <h1 className="text-[clamp(1.6875rem,3.6vw,2.625rem)] leading-[1.04]">
        {title}
      </h1>
      <p className="mt-3.5 mb-10 font-mono text-sm text-text-faint">
        {lastUpdated}
      </p>

      <div className="grid gap-8">
        {sections.map((section) => (
          <section key={section.id} id={section.id} className="scroll-mt-24">
            <h2 className="font-sans text-[1.0625rem] font-600 text-text-strong">
              {section.heading}
            </h2>
            <div className="mt-3 text-[1rem] leading-[1.8] text-text-muted">
              {section.content}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

/** A single "term — description" row inside a legal list (e.g. "What we collect"). */
export function LegalListItem({
  term,
  children,
  className,
}: {
  term?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn(className)}>
      {term ? <span className="text-text-strong">{term}</span> : null}
      {term ? " — " : null}
      {children}
    </div>
  );
}

/** A stack of `LegalListItem`s with consistent spacing. */
export function LegalList({ children }: { children: ReactNode }) {
  return <div className="grid gap-2.5">{children}</div>;
}
