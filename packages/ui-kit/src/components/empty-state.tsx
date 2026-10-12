import type { ReactNode } from "react";

import { cn } from "../lib/utils";

/**
 * The "there is nothing here yet" block.
 *
 * ## Why this exists
 *
 * Roughly five of the app's forty-seven components had a designed empty state,
 * and the entry point had none at all. The ones that did exist were each
 * hand-rolled — a dashed border here, a muted paragraph there, a different icon
 * treatment in each — so they read as three different products even inside one
 * page.
 *
 * An empty state is not a hole in the UI; it is the first thing a new user
 * sees, and it is the only chance to say what would fill it. So it gets a
 * primitive, with a slot for the one action that would.
 */
export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
  /** `dashed` reads as "something belongs here"; `plain` as "nothing does". */
  variant = "dashed",
}: {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
  variant?: "dashed" | "plain";
}) {
  return (
    <div
      className={cn(
        "rounded-lg p-6 text-center sm:p-10",
        variant === "dashed" && "border border-dashed border-line",
        className,
      )}
    >
      {icon ? (
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-surface-panel text-text-muted">
          {icon}
        </div>
      ) : null}
      <h2
        className={cn(
          "text-base font-medium text-text-strong",
          icon ? "mt-4" : undefined,
        )}
      >
        {title}
      </h2>
      {description ? (
        <p className="mx-auto mt-1 max-w-sm text-sm text-text-muted">
          {description}
        </p>
      ) : null}
      {action ? <div className="mt-6">{action}</div> : null}
    </div>
  );
}
