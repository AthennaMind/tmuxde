"use client";

import { X } from "lucide-react";
import { cn } from "@repo/ui/lib/utils";
import { useAlertStore } from "@/stores/alert-store";

// A `/15` wash is nearly the page background, so the text has to be the *solid*
// status color — its `-foreground` is the pairing for a solid fill, not a wash.
const typeStyles: Record<string, string> = {
  info: "bg-info/15 text-info",
  success: "bg-success/15 text-success",
  warning: "bg-warning/15 text-warning",
  error: "bg-destructive/15 text-destructive",
};

export function AlertBanner() {
  const alerts = useAlertStore((s) => s.alerts);
  const dismiss = useAlertStore((s) => s.dismiss);

  if (alerts.length === 0) return null;

  const latest = alerts[alerts.length - 1]!;
  const extraCount = alerts.length - 1;

  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        "flex items-center gap-1.5 rounded-md px-2 py-0.5 text-xs font-medium transition-all animate-in fade-in slide-in-from-top-1 duration-200",
        // The banner grows on a touch device so its dismiss button can reach
        // the 44px floor. It was 16px — which is not a small target, it is a
        // target you miss, on the one control whose whole job is to get an
        // interruption off the screen.
        "pointer-coarse:min-h-11",
        typeStyles[latest.type],
      )}
    >
      <span
        className="truncate max-w-[200px] sm:max-w-[300px]"
        title={latest.message}
      >
        {latest.message}
      </span>
      {extraCount > 0 && (
        <span
          className="shrink-0 rounded-full bg-foreground/10 px-1.5 text-[11px]"
          title={`${extraCount} more alert${extraCount === 1 ? "" : "s"}`}
        >
          +{extraCount}
        </span>
      )}
      <button
        className="flex shrink-0 items-center justify-center rounded-sm p-0.5 transition-colors hover:bg-foreground/10 pointer-coarse:h-11 pointer-coarse:w-11"
        onClick={() => dismiss(latest.id)}
        aria-label="Dismiss alert"
        title="Dismiss alert"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}
