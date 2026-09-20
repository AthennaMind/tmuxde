"use client";

import { cn } from "../lib/utils";

export type ConnectionStatusType =
  | "connected"
  | "connecting"
  | "reconnecting"
  | "disconnected";

const statusConfig: Record<
  ConnectionStatusType,
  { color: string; label: string; pulse: boolean }
> = {
  connected: { color: "bg-success", label: "Connected", pulse: false },
  connecting: { color: "bg-warning", label: "Connecting...", pulse: true },
  reconnecting: { color: "bg-warning", label: "Reconnecting...", pulse: true },
  disconnected: {
    color: "bg-destructive",
    label: "Disconnected",
    pulse: false,
  },
};

interface ConnectionStatusProps {
  status: ConnectionStatusType;
  latency?: number;
  reconnectCount?: number;
  hostname?: string;
  className?: string;
  showLabel?: boolean;
  onReconnect?: () => void;
}

export function ConnectionStatus({
  status,
  latency,
  reconnectCount,
  hostname,
  className,
  showLabel = true,
  onReconnect,
}: ConnectionStatusProps) {
  const config = statusConfig[status];

  /*
   * The same detail the `title` carries, as text a screen reader will read and
   * a phone can reach. `title` is a hover affordance: on a touch device there
   * is no hover, so latency and hostname were visible to mouse users only and
   * to nobody else. The visible label is hidden from assistive tech because
   * this string already contains it — otherwise it is announced twice.
   */
  const detailParts: string[] = [config.label];
  if (hostname) detailParts.push(`Host: ${hostname}`);
  if (status === "connected" && latency != null)
    detailParts.push(`Latency: ${latency}ms`);
  if (reconnectCount && reconnectCount > 0)
    detailParts.push(`Reconnects: ${reconnectCount}`);
  const detail = detailParts.join(" | ");

  return (
    <div className={cn("flex items-center gap-2", className)} title={detail}>
      {/* Not a live region: latency refreshes on a timer, and announcing every
          refresh would make the indicator unusable with a screen reader on. */}
      <span className="sr-only">{detail}</span>
      <span className="relative flex h-3 w-3" aria-hidden>
        {config.pulse && (
          <span
            className={cn(
              "absolute inline-flex h-full w-full animate-ping rounded-full opacity-75",
              config.color,
            )}
          />
        )}
        <span
          className={cn(
            "relative inline-flex h-3 w-3 rounded-full",
            config.color,
          )}
        />
      </span>
      {showLabel && (
        <span className="text-xs text-muted-foreground" aria-hidden>
          {config.label}
          {status === "reconnecting" &&
            reconnectCount != null &&
            reconnectCount > 0 && (
              <span className="ml-1 text-foreground/70">#{reconnectCount}</span>
            )}
          {status === "connected" && latency != null && (
            <span className="ml-1 text-foreground/70">{latency}ms</span>
          )}
          {/* Shown, not just tooltipped, for the same reason as above — and
              truncated because a tunnel hostname is longer than the header. */}
          {hostname && (
            <span className="ml-1 hidden max-w-[10ch] truncate align-bottom text-foreground/70 sm:inline-block">
              {hostname}
            </span>
          )}
        </span>
      )}
      {(status === "disconnected" || status === "reconnecting") &&
        onReconnect && (
          /* 44px of button, 18px of pill. This is the header's half of the
           recovery controls — see ConnectionBanner for the other half — and it
           was the smallest target on a screen whose whole purpose at that
           moment is to be pressed. */
          <button
            className="group flex min-h-11 items-center rounded focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            aria-label="Retry the connection"
            onClick={onReconnect}
          >
            <span className="rounded px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground transition-colors group-hover:bg-accent group-hover:text-foreground">
              Retry
            </span>
          </button>
        )}
    </div>
  );
}
