"use client";

import { PanelLeftClose } from "lucide-react";
import { cn } from "@repo/ui/lib/utils";
import { useUiStore } from "@/stores/ui-store";

/**
 * Top row of a sidebar view.
 *
 * 44px, the same as the file tab strip beside it, so both bottom borders line
 * up when a file is open.
 */
export function PanelHeader({
  title,
  children,
  className,
}: {
  title: React.ReactNode;
  /** View actions, drawn before the collapse button. */
  children?: React.ReactNode;
  className?: string;
}) {
  const toggleSidebar = useUiStore((s) => s.toggleSidebar);
  return (
    <div
      className={cn(
        "flex min-h-11 shrink-0 items-center gap-1 border-b ps-3 pe-1",
        className,
      )}
    >
      <h2 className="min-w-0 flex-1 truncate font-chrome text-[13px] font-medium">
        {title}
      </h2>
      {children}
      <PanelIconButton
        label="Hide sidebar (Ctrl+B)"
        onClick={toggleSidebar}
        icon={PanelLeftClose}
      />
    </div>
  );
}

export function PanelIconButton({
  label,
  icon: Icon,
  onClick,
  disabled,
  pressed,
  spinning,
}: {
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  onClick: () => void;
  disabled?: boolean;
  pressed?: boolean;
  spinning?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        pressed && "bg-accent text-foreground",
      )}
    >
      <Icon
        className={cn(
          "h-4 w-4",
          spinning && "animate-spin motion-reduce:animate-none",
        )}
      />
    </button>
  );
}
