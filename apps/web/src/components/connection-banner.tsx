"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, WifiOff } from "lucide-react";
import { cn } from "@repo/ui/lib/utils";
import { useConnectionStore } from "@/stores/connection-store";
import { getRelayClient, reconnectWithFreshRoute } from "@/hooks/use-websocket";
import { forgetActiveSession } from "@/lib/forget-session";
import { isPairedSession } from "@/lib/relay-url";

/**
 * Slim, persistent banner shown only while the socket is disconnected or
 * reconnecting, so users get clear feedback instead of typing into a dead
 * terminal. Rendered at the bottom of the AppShell header so it *displaces*
 * the content area — as an overlay it sat on top of terminal row 1, hiding
 * output exactly when the user is trying to work out what went wrong.
 *
 * ## Why the reconnecting state has controls now
 *
 * It used to have none: the Retry button was gated on `!reconnecting`, on the
 * reasoning that a retry is already in flight so a button would be redundant.
 * That reasoning holds only while the retry can succeed. A session pinned to a
 * LAN address the device can no longer reach retries forever, and the screen
 * said "Reconnecting (attempt 47)" with nothing to press — the state where a
 * control is *most* needed was the one state that had none.
 *
 * Three, escalating, and the third only once the first two have plainly failed:
 * retry now, try a different route, start over.
 */

/** Failed attempts before "this may not fix itself" becomes worth saying. */
const STUCK_AFTER = 5;

export function ConnectionBanner() {
  const router = useRouter();
  const status = useConnectionStore((s) => s.status);
  const reconnectCount = useConnectionStore((s) => s.reconnectCount);
  const [confirmingForget, setConfirmingForget] = useState(false);

  // Only surface the "degraded" states. Initial "connecting"/"authenticating"
  // is handled by the header ConnectionStatus indicator.
  if (status !== "disconnected" && status !== "reconnecting") {
    return null;
  }

  const reconnecting = status === "reconnecting";
  const stuck = reconnectCount >= STUCK_AFTER;

  const forget = () => {
    void (async () => {
      // Stop the reconnect loop first, or it races the navigation and puts the
      // banner back on the page we are leaving.
      getRelayClient()?.disconnect();
      await forgetActiveSession();
      router.replace("/start");
    })();
  };

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

      {confirmingForget ? (
        <>
          {/* Spelled out, because this is the one control here that destroys
              something: the keys are the only way back to that machine. */}
          <span className="truncate">
            Forget this machine? You will need to pair again.
          </span>
          <BannerButton onClick={forget}>Forget it</BannerButton>
          <BannerButton onClick={() => setConfirmingForget(false)}>
            Cancel
          </BannerButton>
        </>
      ) : (
        <>
          <BannerButton onClick={() => getRelayClient()?.connect()}>
            Retry now
          </BannerButton>

          {/* Only once retrying has visibly not worked. Offered earlier it
              reads as a thing you are supposed to understand and choose
              between, which is exactly what someone staring at a dead terminal
              does not want. */}
          {stuck && (
            <BannerButton onClick={() => void reconnectWithFreshRoute()}>
              Try another route
            </BannerButton>
          )}

          {/* Self-hosted sessions have nothing to forget — the token is the
              credential and /start cannot re-issue it. */}
          {stuck && isPairedSession() && (
            <BannerButton onClick={() => setConfirmingForget(true)}>
              Pair again
            </BannerButton>
          )}
        </>
      )}
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
