import { cn } from "@/shared/utils";

/** One line of status or error text inside a panel. */
export function Notice({
  children,
  error = false,
}: {
  children: React.ReactNode;
  error?: boolean;
}) {
  return (
    <p
      role={error ? "alert" : "status"}
      className={cn(
        "px-4 py-6 text-sm leading-relaxed",
        error ? "text-destructive" : "text-muted-foreground",
      )}
    >
      {children}
    </p>
  );
}
