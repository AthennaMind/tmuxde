import { cn } from "@/shared/utils";

/** Git status letter, colored, with its meaning for screen readers. */
export function ChangeCode({ code }: { code: string }) {
  return (
    <span
      className={cn(
        "w-4 shrink-0 font-mono text-xs font-semibold",
        code === "D"
          ? "text-term-removed"
          : code === "A" || code === "?"
            ? "text-term-added"
            : "text-term-path",
      )}
    >
      <span aria-hidden>{code}</span>
      <span className="sr-only">{changeLabel(code)}</span>
    </span>
  );
}

function changeLabel(code: string) {
  return (
    (
      {
        M: "Modified",
        A: "Added",
        D: "Deleted",
        R: "Renamed",
        C: "Copied",
        U: "Conflict",
        T: "Type changed",
        "?": "Untracked",
      } as Record<string, string>
    )[code] ?? "Changed"
  );
}
