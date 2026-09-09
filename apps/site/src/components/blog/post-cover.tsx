import {
  Bot,
  GitCompareArrows,
  ShieldCheck,
  Smartphone,
  SquareTerminal,
  type LucideIcon,
} from "lucide-react";

import type { Frontmatter } from "@/lib/blog";
import { cn } from "@/lib/utils";

/**
 * Generated post covers.
 *
 * Posts have no cover images and should not need any — sourcing and
 * maintaining artwork for every article is exactly the kind of cost that stops
 * people publishing. Instead each cover is drawn in code from data the post
 * already carries: its category picks a glyph, and the slug picks one of three
 * light positions so a grid of cards does not look mechanically identical.
 *
 * A post can override the glyph with an `icon` emoji in its frontmatter when a
 * category default is too generic (say 🍎 on the macOS post).
 *
 * Everything is drawn with design tokens, so covers follow a retheme for free.
 */

const CATEGORY_ICON: Record<Frontmatter["category"], LucideIcon> = {
  tmux: SquareTerminal,
  agents: Bot,
  comparisons: GitCompareArrows,
  mobile: Smartphone,
  security: ShieldCheck,
};

/** Deterministic, stable across builds — no randomness in a static render. */
function hash(slug: string): number {
  let h = 0;
  for (let i = 0; i < slug.length; i += 1) {
    h = (h * 31 + slug.charCodeAt(i)) >>> 0;
  }
  return h;
}

const LIGHT_POSITION = ["at 28% 22%", "at 72% 30%", "at 50% 78%"] as const;

export function PostCover({
  category,
  icon,
  slug,
  className,
  size = "md",
}: {
  category: Frontmatter["category"];
  icon?: string;
  slug: string;
  className?: string;
  /** `md` card, `lg` featured card, `banner` the post page header. */
  size?: "md" | "lg" | "banner";
}) {
  const Icon = CATEGORY_ICON[category] ?? SquareTerminal;
  const light = LIGHT_POSITION[hash(slug) % LIGHT_POSITION.length];

  return (
    <div
      aria-hidden="true"
      className={cn(
        "relative isolate flex items-center justify-center overflow-hidden bg-surface-sunken",
        size === "banner"
          ? // Self-contained tile on the article page, so it needs its own border
            // and radius rather than sitting flush inside a card.
            "h-28 rounded-xl border border-line sm:h-36"
          : "border-b border-line-subtle",
        size === "md" && "aspect-[16/9]",
        size === "lg" && "aspect-[16/9] sm:aspect-auto sm:h-full",
        className,
      )}
    >
      {/* Dot grid, faded out towards the edges. */}
      <div
        className="absolute inset-0 [mask-image:radial-gradient(ellipse_at_center,black,transparent_82%)]"
        style={{
          backgroundImage:
            "radial-gradient(circle, var(--color-line-strong) 1px, transparent 1px)",
          backgroundSize: "16px 16px",
        }}
      />

      {/* Brand wash, positioned from the slug hash. */}
      <div
        className="absolute inset-0"
        style={{
          backgroundImage: `radial-gradient(60% 60% ${light}, var(--brand-glow), transparent 70%)`,
        }}
      />

      {icon ? (
        <span
          className={cn(
            "relative select-none drop-shadow-[0_2px_12px_var(--brand-glow)]",
            size === "lg" && "text-[4rem]",
            size === "md" && "text-[3rem]",
            size === "banner" && "text-[2.625rem] sm:text-[3.25rem]",
          )}
        >
          {icon}
        </span>
      ) : (
        <Icon
          className={cn(
            "relative text-brand drop-shadow-[0_2px_12px_var(--brand-glow)]",
            size === "lg" && "size-16",
            size === "md" && "size-12",
            size === "banner" && "size-10 sm:size-13",
          )}
          strokeWidth={1.25}
        />
      )}
    </div>
  );
}
