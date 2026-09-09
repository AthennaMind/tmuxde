import { cn } from "@/lib/utils";

/**
 * The mark is a two-pane split — the smallest possible drawing of a tmux
 * window. It doubles as the favicon and the OG image glyph.
 */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      role="img"
      aria-hidden="true"
      focusable="false"
      className={cn("size-6", className)}
    >
      <rect width="24" height="24" rx="5" className="fill-brand" />
      <rect
        x="4"
        y="6"
        width="7"
        height="12"
        rx="1.5"
        className="fill-brand-contrast"
      />
      <rect
        x="13"
        y="6"
        width="7"
        height="5"
        rx="1.5"
        className="fill-brand-contrast"
      />
      <rect
        x="13"
        y="13"
        width="7"
        height="5"
        rx="1.5"
        className="fill-brand-contrast opacity-45"
      />
    </svg>
  );
}

export function Logo({
  className,
  markClassName,
}: {
  className?: string;
  markClassName?: string;
}) {
  return (
    <span className={cn("inline-flex items-center gap-2.5", className)}>
      <LogoMark className={markClassName} />
      <span className="font-display text-[1.125rem] font-600 tracking-[-0.04em] text-text-strong">
        mtmux
      </span>
    </span>
  );
}
