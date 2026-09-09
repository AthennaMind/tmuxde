"use client";

import type { ReactNode } from "react";

import { Link, usePathname } from "@/i18n/navigation";
import { cn } from "@/lib/utils";

/**
 * A nav link that marks itself current. Section pages (`/blog/some-post`)
 * keep `/blog` highlighted.
 */
export function NavLink({
  href,
  children,
  className,
}: {
  href: string;
  children: ReactNode;
  className?: string;
}) {
  const pathname = usePathname();
  const isActive = href === "/" ? pathname === "/" : pathname.startsWith(href);

  return (
    <Link
      href={href}
      aria-current={isActive ? "page" : undefined}
      className={cn(
        "relative rounded-md px-3 py-2 text-[1rem] text-text-muted transition-colors hover:bg-surface-panel hover:text-text-strong",
        isActive && "text-text-strong",
        className,
      )}
    >
      {children}
      {isActive ? (
        <span
          aria-hidden="true"
          className="absolute inset-x-3 bottom-1 h-px bg-brand"
        />
      ) : null}
    </Link>
  );
}
