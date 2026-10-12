import { useId, useRef, type ReactNode } from "react";

import { cn } from "../lib/utils";

/**
 * One choice out of a handful, laid out as a row of segments.
 *
 * ## Why a primitive rather than three buttons
 *
 * The app grew three of these by hand — the share dialog's "Files" and
 * "Expires" rows, and billing's monthly/yearly picker — and each got the
 * accessibility half-right in a different way. The share dialog used bare
 * `<button aria-pressed>`, which announces three independent toggles rather
 * than one choice, so a screen reader user hears "No files, toggle button, not
 * pressed" with nothing tying it to the other two. Billing used the right roles
 * and then shipped no keyboard support at all, so arrow keys did nothing and
 * every segment was a separate tab stop.
 *
 * This is the APG radiogroup pattern, which is what both of them were reaching
 * for: **one** tab stop for the whole group (roving tabindex), arrows to move
 * between segments, Home/End to jump to the ends. Selection follows focus,
 * which is correct here because every option is inert until something else is
 * submitted — nothing is fetched or destroyed by arrowing past it.
 *
 * `role="radiogroup"` needs a name, so `label` is required. Pass
 * `labelledBy` instead when a visible `<Label>` already says it, so the name is
 * not duplicated.
 */
export type SegmentedOption<T extends string> = {
  value: T;
  label: ReactNode;
  /** Announced instead of `label` when the visible text is an abbreviation. */
  ariaLabel?: string;
  disabled?: boolean;
};

export function SegmentedControl<T extends string>({
  value,
  onChange,
  options,
  label,
  labelledBy,
  className,
  segmentClassName,
}: {
  value: T;
  onChange: (value: T) => void;
  options: readonly SegmentedOption<T>[];
  /** The group's accessible name. Omit only when `labelledBy` is given. */
  label?: string;
  /** Id of a visible label, when there already is one. */
  labelledBy?: string;
  className?: string;
  segmentClassName?: string;
}) {
  const groupId = useId();
  const refs = useRef<Map<string, HTMLButtonElement>>(new Map());

  const enabled = options.filter((option) => !option.disabled);

  /**
   * The roving tab stop.
   *
   * The selected segment carries it, so tabbing in lands on the current answer
   * rather than on the first one — which matters because arrowing then moves
   * *from* what is selected. When the value matches nothing (a stale value, or
   * a group that starts empty) the first enabled segment takes it, so the group
   * is never a dead tab stop.
   */
  const focusable =
    enabled.find((option) => option.value === value)?.value ??
    enabled[0]?.value;

  function focusAndSelect(next: T) {
    onChange(next);
    // After the state change, so the element is not re-created underneath us.
    queueMicrotask(() => refs.current.get(next)?.focus());
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLButtonElement>) {
    const index = enabled.findIndex((option) => option.value === value);
    const from = index === -1 ? 0 : index;
    let target: number;

    switch (event.key) {
      case "ArrowRight":
      case "ArrowDown":
        target = (from + 1) % enabled.length;
        break;
      case "ArrowLeft":
      case "ArrowUp":
        target = (from - 1 + enabled.length) % enabled.length;
        break;
      case "Home":
        target = 0;
        break;
      case "End":
        target = enabled.length - 1;
        break;
      default:
        return;
    }

    const next = enabled[target];
    if (!next) return;
    // Only after we know the key was ours, so Tab and typing still work.
    event.preventDefault();
    focusAndSelect(next.value);
  }

  return (
    <div
      role="radiogroup"
      aria-label={labelledBy ? undefined : label}
      aria-labelledby={labelledBy}
      className={cn("flex flex-wrap gap-2", className)}
    >
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            ref={(node) => {
              if (node) refs.current.set(option.value, node);
              else refs.current.delete(option.value);
            }}
            type="button"
            role="radio"
            id={`${groupId}-${option.value}`}
            aria-checked={selected}
            aria-label={option.ariaLabel}
            disabled={option.disabled}
            tabIndex={option.value === focusable ? 0 : -1}
            onClick={() => onChange(option.value)}
            onKeyDown={handleKeyDown}
            className={cn(
              // 44px, because these are the controls a share is configured
              // with on a phone and they were 38.
              "min-h-11 rounded-md border px-3 py-2 text-sm transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              "disabled:cursor-not-allowed disabled:opacity-50",
              selected
                ? "border-primary bg-primary/10 text-foreground"
                : "border-border text-muted-foreground hover:text-foreground",
              segmentClassName,
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
