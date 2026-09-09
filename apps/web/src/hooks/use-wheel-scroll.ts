"use client";

import { useCallback, useRef } from "react";
import { flushScroll, scrollByLines } from "@/lib/terminal-scroll";

/** A wheel notch, in lines, when the event reports pixels. */
const PIXELS_PER_LINE = 20;

/** Longest a burst of wheel events is allowed to sit before it is sent. */
const IDLE_FLUSH_MS = 120;

/**
 * Turn a wheel or trackpad gesture over the terminal into tmux history scroll.
 *
 * There was nothing here at all, which is why a mouse could not scroll the
 * terminal: `tmux attach-session` puts tmux on the alternate screen, so xterm's
 * own viewport has nothing in it and its wheel handler moves an empty buffer by
 * zero lines. The history lives in tmux and is reachable only from copy mode,
 * so the wheel has to become a `tmux:scroll` like every other affordance —
 * see `lib/terminal-scroll.ts` for the coalescing they share.
 *
 * Non-passive and in the capture phase on purpose: it must run ahead of
 * xterm's own listener, and it must be allowed to `preventDefault` so a
 * trackpad flick does not also rubber-band the page.
 *
 * Returns a ref callback: put it on the element the wheel should scroll. A
 * callback rather than a `RefObject` because the workspace renders two panes
 * — the touch layout's and the desktop one's — and swapping between them
 * replaces the node without changing any dependency an effect could watch. A
 * callback ref is told about the swap by React itself.
 */
export function useWheelScroll(): (node: HTMLElement | null) => void {
  const detach = useRef<(() => void) | null>(null);

  return useCallback((node: HTMLElement | null) => {
    detach.current?.();
    detach.current = null;
    if (!node) return;

    let idle: ReturnType<typeof setTimeout> | null = null;
    /** Sub-line remainders, so a fine trackpad does not round to nothing. */
    let residue = 0;

    const onWheel = (event: WheelEvent) => {
      // `deltaMode` 1 is lines, 2 is pages; 0 (pixels) is what a trackpad and
      // most mice report, and dividing by a nominal line height is the same
      // approximation xterm's own viewport makes.
      const lines =
        event.deltaMode === 1
          ? event.deltaY
          : event.deltaMode === 2
            ? event.deltaY * 10
            : event.deltaY / PIXELS_PER_LINE;
      residue += lines;
      const whole = Math.trunc(residue);
      residue -= whole;
      if (whole !== 0) {
        // Wheel down is forward in time, which is a *negative* `tmux:scroll`.
        scrollByLines(-whole);
      }
      event.preventDefault();
      if (idle !== null) clearTimeout(idle);
      idle = setTimeout(() => {
        idle = null;
        residue = 0;
        flushScroll();
      }, IDLE_FLUSH_MS);
    };

    node.addEventListener("wheel", onWheel, { passive: false, capture: true });
    detach.current = () => {
      if (idle !== null) clearTimeout(idle);
      node.removeEventListener("wheel", onWheel, { capture: true });
    };
  }, []);
}
