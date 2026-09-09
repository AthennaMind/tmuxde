"use client";

import { useUiStore } from "@/stores/ui-store";

/**
 * A brief pill naming what a switch just landed on.
 *
 * tmux redraws the destination window over the same shell, the same prompt and
 * often the same directory, so a correct window switch can look identical to
 * doing nothing. This is the acknowledgement — not decoration. It is the
 * difference between "the swipe is broken" and "I am on window 2 now".
 *
 * `aria-live="polite"` rather than a `role="alert"`: it should be read after
 * whatever the user was already hearing, never interrupt it.
 */
export function SwitchHint() {
  const hint = useUiStore((s) => s.switchHint);

  return (
    <div
      className="pointer-events-none absolute inset-x-0 top-3 z-[var(--z-banner)] flex justify-center"
      aria-live="polite"
      aria-atomic="true"
    >
      {hint && (
        <span className="animate-in fade-in zoom-in-95 rounded-full bg-foreground/85 px-3 py-1 text-xs font-medium text-background shadow-lg backdrop-blur-sm">
          {hint}
        </span>
      )}
    </div>
  );
}
