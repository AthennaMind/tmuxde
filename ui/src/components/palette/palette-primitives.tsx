import type { ReactNode } from "react";
import { Command } from "cmdk";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { splitHighlight, type Range } from "@/lib/palette-match";

/** Outer panel radius 22px, 8px padding, so rows sit at 14px. */
export const LIST_CLASS = "min-h-0 flex-1 overflow-y-auto overscroll-contain p-2";

export const GROUP_CLASS =
  "[&_[cmdk-group-heading]]:select-none [&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-3 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:leading-4 [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-muted-foreground";

export const ROW_CLASS =
  "group flex min-h-11 cursor-pointer select-none items-center gap-3 rounded-[0.875rem] px-3 py-2 text-sm text-foreground outline-none data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground";

export const CONTROL_CLASS =
  "transition-[background-color,color,scale] duration-150 ease-out active:scale-[0.96] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring";

export interface PaletteItem {
  id: string;
  label: string;
  detail?: string;
  keywords?: string[];
  icon: ReactNode;
  shortcut?: string[];
  /** Label is a command or a name from the terminal. */
  mono?: boolean;
  /** The state the app is already in, marked with a check. */
  current?: boolean;
  destructive?: boolean;
  run: () => void;
}

export function Kbd({
  children,
  className,
  ...props
}: {
  children: ReactNode;
  className?: string;
  "aria-hidden"?: boolean;
}) {
  return (
    <kbd
      {...props}
      className={cn(
        "inline-flex h-5 min-w-5 items-center justify-center rounded-md bg-foreground/[0.06] px-1.5 font-mono text-[11px] leading-none text-muted-foreground ring-1 ring-inset ring-foreground/10",
        className,
      )}
    >
      {children}
    </kbd>
  );
}

export function Highlight({ text, ranges }: { text: string; ranges: readonly Range[] }) {
  if (!ranges.length) return <>{text}</>;
  return (
    <>
      {splitHighlight(text, ranges).map((part, index) =>
        part.hit ? (
          <mark key={index} className="bg-transparent font-semibold text-current">
            {part.text}
          </mark>
        ) : (
          <span key={index}>{part.text}</span>
        ),
      )}
    </>
  );
}

export function PaletteRow({
  item,
  ranges = [],
}: {
  item: PaletteItem;
  ranges?: readonly Range[];
}) {
  return (
    <Command.Item value={item.id} onSelect={item.run} title={item.detail} className={ROW_CLASS}>
      <span
        aria-hidden
        className={cn(
          "flex size-[18px] shrink-0 items-center justify-center [&_svg]:size-[18px]",
          item.destructive
            ? "text-destructive"
            : "text-muted-foreground group-data-[selected=true]:text-accent-foreground",
        )}
      >
        {item.icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className={cn("block truncate", item.mono ? "font-chrome" : "font-medium")}>
          <Highlight text={item.label} ranges={ranges} />
        </span>
        {item.detail && (
          <span className="block truncate font-chrome text-xs text-muted-foreground">
            {item.detail}
          </span>
        )}
      </span>
      {item.current && (
        <>
          <Check className="size-4 shrink-0 text-primary" aria-hidden />
          <span className="sr-only">Current</span>
        </>
      )}
      {item.shortcut && (
        <span className="hidden shrink-0 items-center gap-1 sm:flex" aria-hidden>
          {item.shortcut.map((key, index) => (
            <Kbd key={index}>{key}</Kbd>
          ))}
        </span>
      )}
    </Command.Item>
  );
}

export function PaletteEmpty({
  children,
  action,
}: {
  children: ReactNode;
  action?: { label: string; onClick: () => void };
}) {
  return (
    <div className="flex flex-col items-center gap-3 px-6 py-10 text-center">
      <p className="text-sm text-muted-foreground">{children}</p>
      {action && (
        <button
          type="button"
          onClick={action.onClick}
          className={cn(
            "min-h-10 rounded-xl bg-accent px-4 text-sm font-medium text-accent-foreground",
            CONTROL_CLASS,
          )}
        >
          {action.label}
        </button>
      )}
    </div>
  );
}

/** One line: context on the leading side, key hints trailing on desktop. */
export function PaletteFooter({
  left,
  right = [],
}: {
  left?: ReactNode;
  right?: [string, string][];
}) {
  return (
    <div className="flex h-10 shrink-0 items-center gap-4 border-t border-foreground/10 px-4 text-[11px] leading-4 text-muted-foreground">
      <div className="flex min-w-0 flex-1 items-center gap-2">{left}</div>
      {right.length > 0 && (
        <div className="hidden shrink-0 items-center gap-3 sm:flex" aria-hidden>
          {right.map(([key, label]) => (
            <span key={label} className="flex items-center gap-1">
              <Kbd>{key}</Kbd>
              {label}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/** Machine, session and folder as separate truncating pieces. */
export function ContextLine({ parts }: { parts: (string | null | undefined)[] }) {
  const visible = parts.filter((part): part is string => !!part);
  return (
    <>
      {visible.map((part, index) => (
        <span key={index} className="flex min-w-0 items-center gap-2">
          {index > 0 && (
            <span aria-hidden className="opacity-50">
              ·
            </span>
          )}
          <span className={cn("truncate", index > 0 && "font-chrome")}>{part}</span>
        </span>
      ))}
    </>
  );
}
