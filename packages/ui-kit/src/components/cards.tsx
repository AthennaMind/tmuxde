import type { ReactNode } from "react";

import { cn } from "../lib/utils";

/**
 * Ported from `apps/site/src/components/primitives/cards.tsx`.
 *
 * A copy rather than an import: the site is a separate Next app with its own
 * build and its own `@/lib/utils` alias. Keeping the markup identical is what
 * makes the app and the site read as one product; the shared half is the token
 * layer in `globals.css`, which both of them now use.
 */

/**
 * A hairline grid: one-pixel gaps filled by the border colour, so adjacent
 * cards share a divider instead of stacking two borders. Used for every
 * feature/stat matrix on the site.
 */
export function HairlineGrid({
  children,
  className,
  minColumnWidth = "16rem",
}: {
  children: ReactNode;
  className?: string;
  minColumnWidth?: string;
}) {
  return (
    <div
      style={{
        gridTemplateColumns: `repeat(auto-fit,minmax(min(${minColumnWidth},100%),1fr))`,
      }}
      className={cn(
        "grid gap-px overflow-hidden rounded-xl border border-line bg-line",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function HairlineCell({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("bg-surface-raised p-5", className)}>{children}</div>
  );
}

export function FeatureCard({
  icon,
  title,
  children,
  className,
}: {
  icon?: ReactNode;
  title: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "rounded-xl border border-line bg-surface-raised p-5 transition-colors hover:border-line-strong",
        className,
      )}
    >
      {icon ? (
        <div className="mb-4 text-brand [&_svg]:size-5">{icon}</div>
      ) : null}
      <h3 className="font-sans text-[1rem] font-600 tracking-[-0.01em] text-text-strong">
        {title}
      </h3>
      <p className="mt-2 text-[0.9063rem] leading-[1.7] text-text-muted">
        {children}
      </p>
    </div>
  );
}

export function StatCard({
  value,
  label,
  className,
}: {
  value: ReactNode;
  label: ReactNode;
  className?: string;
}) {
  return (
    <HairlineCell className={cn("p-6", className)}>
      <p className="font-display text-[1.5625rem] leading-none tracking-[-0.05em] text-brand">
        {value}
      </p>
      <p className="mt-2 text-[0.8125rem] leading-snug text-text-muted">
        {label}
      </p>
    </HairlineCell>
  );
}

/** Numbered step, used by "how it works" sequences. */
export function StepCard({
  index,
  title,
  children,
  footer,
  className,
}: {
  index: number | string;
  title: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  className?: string;
}) {
  return (
    <HairlineCell className={cn("flex flex-col p-6", className)}>
      <span className="font-mono text-[0.8125rem] text-text-faint">
        {String(index).padStart(2, "0")}
      </span>
      <h3 className="mt-5 font-sans text-[1.0625rem] font-600 tracking-[-0.01em] text-text-strong">
        {title}
      </h3>
      {children ? (
        <p className="mt-2 text-[0.9063rem] leading-[1.7] text-text-muted">
          {children}
        </p>
      ) : null}
      {footer ? <div className="mt-auto pt-4">{footer}</div> : null}
    </HairlineCell>
  );
}

/** An on-screen key from the mobile modifier row. */
export function Keycap({
  children,
  active = false,
  className,
}: {
  children: ReactNode;
  active?: boolean;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "grid place-items-center rounded-md border py-3 text-center font-mono text-[0.8125rem]",
        active
          ? "border-transparent bg-brand font-700 text-brand-contrast"
          : "border-line bg-surface-panel text-text-muted",
        className,
      )}
    >
      {children}
    </span>
  );
}

/** Inline monospace fragment for commands referenced in prose. */
export function Cmd({ children }: { children: ReactNode }) {
  return (
    <code className="rounded border border-line-subtle bg-surface-panel px-1.5 py-0.5 font-mono text-[0.875em] text-text-strong">
      {children}
    </code>
  );
}
