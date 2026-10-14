import type { ElementType, ReactNode } from "react";

import { cn } from "../lib/utils";

/**
 * The site's layout primitives, available to the app.
 *
 * Ported from `apps/site/src/components/primitives/section.tsx` rather than
 * imported, because the site is a separate Next app with its own build and
 * `@/lib/utils` alias. They are here so that a page in the app which wants the
 * marketing site's rhythm — `/start`, the dashboard headers, anything with an
 * eyebrow — gets it from the same definition instead of a hand-rolled
 * approximation that drifts by a quarter of a rem.
 */

/**
 * Page section wrapper.
 *
 * `tone` swaps the background band. Alternating `base` and `raised` down a page
 * is what gives the site its horizontal rhythm — pages should not set
 * backgrounds themselves.
 */
export function Section({
  children,
  className,
  innerClassName,
  tone = "base",
  bordered = true,
  as: Tag = "section",
  id,
}: {
  children: ReactNode;
  className?: string;
  innerClassName?: string;
  tone?: "base" | "raised" | "sunken";
  bordered?: boolean;
  as?: ElementType;
  id?: string;
}) {
  return (
    <Tag
      id={id}
      className={cn(
        "relative",
        tone === "raised" && "bg-surface-raised",
        tone === "sunken" && "bg-surface-sunken",
        bordered && "border-t border-line-subtle",
        className,
      )}
    >
      <div
        className={cn(
          "container-content py-(--spacing-section)",
          innerClassName,
        )}
      >
        {children}
      </div>
    </Tag>
  );
}

/** The `// label` eyebrow. Colour follows the section's semantic role. */
export function Eyebrow({
  children,
  tone = "brand",
  className,
}: {
  children: ReactNode;
  tone?: "brand" | "blocked" | "stalled" | "agent" | "muted";
  className?: string;
}) {
  return (
    <p
      className={cn(
        "eyebrow mb-4",
        tone === "brand" && "text-brand",
        tone === "blocked" && "text-signal-blocked",
        tone === "stalled" && "text-signal-stalled",
        tone === "agent" && "text-signal-agent",
        tone === "muted" && "text-text-faint",
        className,
      )}
    >
      <span aria-hidden="true" className="text-text-faint">
        {"// "}
      </span>
      {children}
    </p>
  );
}

/**
 * Section heading block. `level` controls the tag so pages keep a valid
 * heading outline; visual size is set independently by `size`.
 */
export function SectionHeading({
  eyebrow,
  eyebrowTone,
  title,
  description,
  level = 2,
  size = "md",
  align = "start",
  className,
  children,
}: {
  eyebrow?: ReactNode;
  eyebrowTone?: "brand" | "blocked" | "stalled" | "agent" | "muted";
  title: ReactNode;
  description?: ReactNode;
  level?: 1 | 2 | 3;
  size?: "sm" | "md" | "lg";
  align?: "start" | "center";
  className?: string;
  children?: ReactNode;
}) {
  const Heading = `h${level}` as ElementType;

  return (
    <div
      className={cn(
        "max-w-2xl",
        align === "center" && "mx-auto text-center",
        className,
      )}
    >
      {eyebrow ? <Eyebrow tone={eyebrowTone}>{eyebrow}</Eyebrow> : null}
      <Heading
        className={cn(
          "text-balance",
          size === "sm" &&
            "text-[clamp(1.25rem,2.2vw,1.625rem)] leading-[1.08]",
          size === "md" &&
            "text-[clamp(1.5rem,3.1vw,2.1875rem)] leading-[1.04]",
          size === "lg" && "text-[clamp(1.75rem,4.2vw,3rem)] leading-[0.98]",
        )}
      >
        {title}
      </Heading>
      {description ? (
        <p
          className={cn(
            "mt-4 text-[1.0625rem] leading-[1.7] text-text-muted",
            align === "center" && "mx-auto",
          )}
        >
          {description}
        </p>
      ) : null}
      {children}
    </div>
  );
}

/** Highlights a word inside a heading with the brand colour. */
export function Accent({
  children,
  tone = "brand",
}: {
  children: ReactNode;
  tone?: "brand" | "blocked" | "stalled" | "agent";
}) {
  return (
    <span
      className={cn(
        tone === "brand" && "text-brand",
        tone === "blocked" && "text-signal-blocked",
        tone === "stalled" && "text-signal-stalled",
        tone === "agent" && "text-signal-agent",
      )}
    >
      {children}
    </span>
  );
}
