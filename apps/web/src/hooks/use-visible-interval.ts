"use client";

import { useEffect, useRef } from "react";

/**
 * Run something on a timer, but only while the tab is actually being looked at.
 *
 * ## Why this exists
 *
 * The dashboard fetched `/v1/servers` exactly once, on mount, and then never
 * again. `online` is a 90-second window on the broker, so a user who opened the
 * dashboard and *then* ran `mtmux` on their laptop saw "Pair this device"
 * disabled forever, with no recovery but a hard reload — a hard block on
 * onboarding a new phone, which is the single most common way this page is
 * opened.
 *
 * ## Why not a plain `setInterval`
 *
 * A phone's browser tab lives for days in the background. An unconditional
 * timer keeps waking a sleeping process to fetch a list nobody is reading, and
 * every wake is battery and metered bytes. So the timer is torn down when the
 * document hides and rebuilt when it shows.
 *
 * Coming back to a backgrounded tab is also the moment the data is *most*
 * likely to be wrong, so returning fires immediately rather than waiting out
 * the remainder of an interval. `debounceMs` keeps that from turning an
 * alt-tab-heavy desktop session into a request per switch: a wake within
 * `debounceMs` of the last run is a no-op, and the interval carries it.
 *
 * The listener set — `visibilitychange` plus `focus` — is the same idiom
 * `use-websocket.ts` uses to decide when to reconnect, for the same reason:
 * `visibilitychange` alone misses a desktop window that is visible but was not
 * focused.
 */
export function useVisibleInterval(
  callback: () => void,
  intervalMs: number,
  {
    debounceMs = 5_000,
    enabled = true,
  }: {
    /** A wake sooner than this after the last run does nothing. */
    debounceMs?: number;
    enabled?: boolean;
  } = {},
) {
  // Held in a ref so a caller can pass an inline closure without restarting
  // the timer on every render.
  const held = useRef(callback);
  held.current = callback;

  useEffect(() => {
    if (!enabled || typeof document === "undefined") return;

    let timer: ReturnType<typeof setInterval> | null = null;
    // Mount counts as a run: whoever mounted this has just fetched.
    let lastRun = Date.now();

    const run = () => {
      lastRun = Date.now();
      held.current();
    };

    const start = () => {
      if (timer === null) timer = setInterval(run, intervalMs);
    };
    const stop = () => {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    };

    const wake = () => {
      if (document.hidden) {
        stop();
        return;
      }
      start();
      if (Date.now() - lastRun >= debounceMs) run();
    };

    if (!document.hidden) start();
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("focus", wake);

    return () => {
      stop();
      document.removeEventListener("visibilitychange", wake);
      window.removeEventListener("focus", wake);
    };
  }, [intervalMs, debounceMs, enabled]);
}

/**
 * Half the broker's 90-second `onlineWindowSeconds`.
 *
 * Sampling at the window length would mean a machine could be online for a full
 * window before the dashboard noticed; half of it bounds the lie to ~45s
 * without doubling the request rate again for no further gain.
 */
export const SERVERS_POLL_MS = 45_000;
