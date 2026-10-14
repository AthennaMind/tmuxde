import { Eye } from "lucide-react";
import { useConnectionStore } from "@/stores/connection-store";

/**
 * Says out loud that this connection is a scoped share.
 *
 * A read-only viewer whose keystrokes vanish reads as a broken terminal, not
 * as a boundary — the relay refuses `terminal:input` silently, and xterm has no
 * way to know why nothing echoed. This banner is the difference between "the
 * app is broken" and "this is what you were given".
 *
 * Rendered in the header alongside `ConnectionBanner` so it displaces the
 * terminal rather than covering its first row.
 */
export function CapabilityBanner() {
  const capabilities = useConnectionStore((s) => s.capabilities);

  if (!capabilities?.readOnly) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="flex w-full items-center justify-center gap-2 bg-muted px-3 py-1 text-xs font-medium text-muted-foreground"
    >
      <Eye className="h-3.5 w-3.5 shrink-0" aria-hidden />
      <span className="truncate">
        Read-only — you can watch this session but not type into it
      </span>
    </div>
  );
}
