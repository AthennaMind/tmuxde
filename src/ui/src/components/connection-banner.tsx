import { Loader2, WifiOff } from "lucide-react";
import { cn } from "@/lib/utils";
import { useConnectionStore } from "@/stores/connection-store";
import { getRelayClient } from "@/hooks/use-websocket";

/**
 * Slim, persistent banner shown only while the socket is disconnected or
 * reconnecting, so users get clear feedback instead of typing into a dead
 * terminal. Rendered at the bottom of the AppShell header so it displaces the
 * content area. As an overlay it hid terminal row 1 exactly when the user is
 * trying to work out what went wrong.
 *
 * Retry now is offered in both states. The backoff can reach 30 s, and a
 * server that came back should not wait that long.
 */
export function ConnectionBanner() {
  const status = useConnectionStore((s) => s.status);
  const reconnectCount = useConnectionStore((s) => s.reconnectCount);

  // Only surface the "degraded" states. Initial "connecting"/"authenticating"
  // is handled by the header ConnectionStatus indicator.
  if (status !== "disconnected" && status !== "reconnecting") {
    return null;
  }

  const reconnecting = status === "reconnecting";

  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        "flex w-full flex-wrap items-center justify-center gap-2 px-3 py-1 text-xs font-medium",
        reconnecting
          ? "bg-warning/95 text-warning-foreground"
          : "bg-destructive/95 text-destructive-foreground",
      )}
    >
      {reconnecting ? (
        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
      ) : (
        <WifiOff className="h-3.5 w-3.5 shrink-0" />
      )}
      <span className="truncate">
        {reconnecting
          ? `Reconnecting${reconnectCount > 0 ? ` (attempt ${reconnectCount})` : "…"} — input paused`
          : "Disconnected — input paused"}
      </span>

      <BannerButton onClick={() => getRelayClient()?.connect()}>
        Retry now
      </BannerButton>
    </div>
  );
}

/**
 * A pill that stays small but is not small to hit.
 *
 * These were 18px tall, and they are the controls a stranded user jabs at on a
 * phone — the one moment in the app where a missed tap costs the most. The
 * button is a 44px row and the pill is a span inside it, the same split the
 * window tabs use: the target grows, the chrome does not.
 */
function BannerButton({
  onClick,
  children,
}: {
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex min-h-11 shrink-0 items-center rounded focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-current"
    >
      <span className="rounded bg-foreground/10 px-2 py-1 text-[11px] transition-colors group-hover:bg-foreground/20">
        {children}
      </span>
    </button>
  );
}
