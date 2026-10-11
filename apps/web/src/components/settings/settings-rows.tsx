"use client";

import { useId } from "react";
import { Minus, Plus } from "lucide-react";
import { Switch } from "@repo/ui/components/ui/switch";
import { cn } from "@repo/ui/lib/utils";

/**
 * Focus indicator for raw controls on this page.
 *
 * An outline, not a ring. Rings are box shadows, and forced colors mode
 * drops box shadows, so a ring based indicator vanishes there.
 */
export const settingsFocus =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

/** Same indicator on a wrapping label, for visually hidden native inputs. */
export const settingsLabelFocus =
  "has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring";

export function SettingsSection({
  title,
  description,
  action,
  children,
}: {
  title: string;
  description?: React.ReactNode;
  /** Section wide control beside the heading, such as Reset. */
  action?: React.ReactNode;
  children?: React.ReactNode;
}) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="space-y-3">
      <div className="flex items-end justify-between gap-4">
        <div className="min-w-0 space-y-1">
          <h2
            id={headingId}
            className="text-base font-semibold text-foreground text-balance"
          >
            {title}
          </h2>
          {description && (
            <p className="text-[13px] leading-5 text-muted-foreground text-pretty">
              {description}
            </p>
          )}
        </div>
        {action}
      </div>
      {children && (
        <div className="divide-y divide-line-subtle rounded-lg border bg-card">
          {children}
        </div>
      )}
    </section>
  );
}

export interface RowIds {
  /** For the one control a `<label>` names: input or switch. */
  controlId: string;
  labelId: string;
  /** Undefined without a hint, so `aria-describedby` points at nothing real. */
  hintId: string | undefined;
}

/**
 * One setting: name and hint on the leading side, control on the trailing.
 *
 * The control wraps under the text once the row is too narrow for both, so
 * there is no breakpoint to keep in step with the sidebar width.
 */
export function SettingsRow({
  label,
  hint,
  stacked,
  textLabel,
  children,
}: {
  label: string;
  hint?: React.ReactNode;
  /** Control under the text at full width. For grids and chip lists. */
  stacked?: boolean;
  /**
   * Name as plain text, not a `<label>`. For groups (radios, a stepper),
   * which point at it, and for buttons, which keep their own visible name.
   */
  textLabel?: boolean;
  children?: (ids: RowIds) => React.ReactNode;
}) {
  const base = useId();
  const ids: RowIds = {
    controlId: `${base}control`,
    labelId: `${base}label`,
    hintId: hint ? `${base}hint` : undefined,
  };
  const name = "block text-sm font-medium leading-5 text-foreground";
  return (
    <div
      className={cn(
        "flex gap-x-6 gap-y-3 px-4 py-3.5",
        stacked ? "flex-col" : "flex-wrap items-center justify-between",
      )}
    >
      <div
        className={cn("min-w-0 space-y-0.5", !stacked && "flex-1 basis-56")}
      >
        {textLabel ? (
          <span id={ids.labelId} className={name}>
            {label}
          </span>
        ) : (
          <label id={ids.labelId} htmlFor={ids.controlId} className={name}>
            {label}
          </label>
        )}
        {hint && (
          <p
            id={ids.hintId}
            className="text-[13px] leading-5 text-muted-foreground text-pretty"
          >
            {hint}
          </p>
        )}
      </div>
      {children && (
        <div className={stacked ? "min-w-0" : "max-w-full shrink-0"}>
          {children(ids)}
        </div>
      )}
    </div>
  );
}

export interface SegmentOption<T> {
  value: T;
  label: React.ReactNode;
  icon?: React.ReactNode;
  style?: React.CSSProperties;
  className?: string;
}

/**
 * One choice out of a few, as native radios.
 *
 * Native radios with a shared name give arrow key movement and the checked
 * state to assistive tech for free. The inputs are visually hidden and the
 * wrapping label is the segment.
 */
export function Segmented<T extends string | number>({
  value,
  options,
  onChange,
  ids,
}: {
  value: T | undefined;
  options: SegmentOption<T>[];
  onChange: (value: T) => void;
  ids: RowIds;
}) {
  return (
    <div
      role="radiogroup"
      aria-labelledby={ids.labelId}
      aria-describedby={ids.hintId}
      className="inline-flex max-w-full flex-wrap gap-0.5 rounded-lg border border-line-subtle bg-surface-sunken p-[3px]"
    >
      {options.map((option) => (
        <label
          key={String(option.value)}
          style={option.style}
          className={cn(
            "flex min-h-8 cursor-pointer items-center justify-center gap-1.5 rounded-md px-3 text-[13px] whitespace-nowrap text-muted-foreground transition-colors hover:text-foreground pointer-coarse:min-h-11",
            // Brand ring on the chosen one. Surfaces alone sit near 1:1 here.
            "has-[:checked]:bg-card has-[:checked]:text-foreground has-[:checked]:shadow-sm has-[:checked]:ring-1 has-[:checked]:ring-primary",
            settingsLabelFocus,
            option.className,
          )}
        >
          <input
            type="radio"
            name={ids.controlId}
            value={String(option.value)}
            checked={value === option.value}
            onChange={() => onChange(option.value)}
            className="sr-only"
          />
          {option.icon}
          {option.label}
        </label>
      ))}
    </div>
  );
}

/** A number with a step down and a step up. */
export function Stepper({
  value,
  display,
  min,
  max,
  step = 1,
  onChange,
  ids,
  noun,
}: {
  value: number;
  display: string;
  min: number;
  max: number;
  step?: number;
  onChange: (value: number) => void;
  ids: RowIds;
  /** Names the buttons: "Decrease {noun}". */
  noun: string;
}) {
  const button = cn(
    "flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-card hover:text-foreground disabled:pointer-events-none disabled:opacity-40 pointer-coarse:h-11 pointer-coarse:w-11",
    settingsFocus,
  );
  return (
    <div
      role="group"
      aria-labelledby={ids.labelId}
      aria-describedby={ids.hintId}
      className="inline-flex items-center rounded-lg border border-line-subtle bg-surface-sunken p-[3px]"
    >
      <button
        type="button"
        aria-label={`Decrease ${noun}`}
        disabled={value <= min}
        onClick={() => onChange(value - step)}
        className={button}
      >
        <Minus className="h-4 w-4" aria-hidden />
      </button>
      <output
        aria-live="polite"
        className="min-w-14 text-center text-[13px] font-medium tabular-nums text-foreground"
      >
        {display}
      </output>
      <button
        type="button"
        aria-label={`Increase ${noun}`}
        disabled={value >= max}
        onClick={() => onChange(value + step)}
        className={button}
      >
        <Plus className="h-4 w-4" aria-hidden />
      </button>
    </div>
  );
}

/** A setting that is on or off. The label names the on state. */
export function SwitchRow({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: React.ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <SettingsRow label={label} hint={hint}>
      {(ids) => (
        <Switch
          id={ids.controlId}
          aria-labelledby={ids.labelId}
          aria-describedby={ids.hintId}
          checked={checked}
          onCheckedChange={onChange}
        />
      )}
    </SettingsRow>
  );
}
