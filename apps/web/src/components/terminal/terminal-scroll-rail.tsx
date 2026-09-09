"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@repo/ui/lib/utils";
import {
  requestScrollState,
  resetScrollSupport,
  scrollByLines,
  scrollToPosition,
} from "@/lib/terminal-scroll";
import { useScrollStore } from "@/stores/scroll-store";
import { useSessionStore } from "@/stores/session-store";

/** Smallest the thumb is allowed to get, so a long history stays grabbable. */
const MIN_THUMB_PX = 28;

/** At most one `tmux:scroll-to` this often while a drag is in flight. */
const DRAG_SEND_MS = 60;

/** Lines one wheel notch moves, matching what the terminal itself does. */
const WHEEL_LINES = 3;

/** How often the position is re-read while the pane sits inside its history. */
const POLL_MS = 1500;

interface TerminalScrollRailProps {
  /** Whether a session is attached at all; the rail is inert without one. */
  sessionName: string | null;
  className?: string;
}

/**
 * A real scrollbar for the terminal, on the right, drawn from tmux.
 *
 * The terminal had no scroll affordance of any kind. Touch had the one-finger
 * drag in `TerminalGestureSurface` and nothing else — no bar, so no way to see
 * that history existed or how far back the view was — and the desktop layout
 * did not even have that: no gesture surface, no wheel handler, and xterm's own
 * scrollbar permanently absent because `tmux attach-session` puts tmux on the
 * alternate screen and leaves xterm's buffer empty. "Scrolling is broken" was
 * the correct reading of a client that could not scroll.
 *
 * So the geometry has to come from tmux, and it does: `tmux:scroll-state`
 * reports `scroll_position`, `history_size` and `pane_height`, which is exactly
 * a scrollbar's three numbers. The thumb tracks the pane during a drag from
 * local state and from the relay's report otherwise — the report is the source
 * of truth, because output arriving mid-drag really does move the view and a
 * locally predicted position would drift away from it.
 */
export function TerminalScrollRail({
  sessionName,
  className,
}: TerminalScrollRailProps) {
  const position = useScrollStore((s) => s.position);
  const historySize = useScrollStore((s) => s.historySize);
  const paneHeight = useScrollStore((s) => s.paneHeight);
  const known = useScrollStore((s) => s.known);
  const clearScrollState = useScrollStore((s) => s.clearScrollState);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);

  const trackRef = useRef<HTMLDivElement | null>(null);
  /** Non-null only while a thumb drag is in flight; wins over the report. */
  const [dragPosition, setDragPosition] = useState<number | null>(null);
  const lastSend = useRef(0);
  const sendTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // A fresh session's history is a different history. Asking on the next tick
  // rather than immediately gives the relay's attach time to land, so the
  // first answer describes the pane the user is now looking at.
  useEffect(() => {
    clearScrollState();
    // The next attach may be a different machine, so what the last relay could
    // or could not answer says nothing about this one.
    resetScrollSupport();
    if (!activeSessionId) return;
    const id = setTimeout(requestScrollState, 250);
    return () => clearTimeout(id);
  }, [activeSessionId, clearScrollState]);

  /*
   * Poll only while it matters.
   *
   * Each read is an `execFile` of `tmux` on the machine, so a permanent
   * heartbeat would be a background cost for the overwhelmingly common case —
   * a pane at the bottom, where the thumb is at the bottom whatever the
   * history does. Inside the history it is worth the spawn: the user is
   * looking at the thumb, and output arriving below them moves it.
   */
  const scrolledBack = position > 0;
  useEffect(() => {
    if (!activeSessionId || !scrolledBack) return;
    const id = setInterval(requestScrollState, POLL_MS);
    return () => clearInterval(id);
  }, [activeSessionId, scrolledBack]);

  useEffect(
    () => () => {
      if (sendTimer.current !== null) clearTimeout(sendTimer.current);
    },
    [],
  );

  const total = historySize + paneHeight;
  const shown = dragPosition ?? position;
  const hasHistory = historySize > 0 && paneHeight > 0;

  /*
   * The thumb is sized and placed in pixels, not percentages.
   *
   * `MIN_THUMB_PX` is why: a thumb clamped up to stay grabbable no longer
   * covers the fraction of the track its percentage claims, so a percentage
   * `top` walks it off the bottom end exactly when the user has dragged to the
   * oldest line. Measuring the track and doing the arithmetic once keeps the
   * thumb and `positionForClientY` reading the same geometry.
   */
  const [trackHeight, setTrackHeight] = useState(0);
  /*
   * Measured from a ref callback, not an effect.
   *
   * The rail renders nothing until a session is attached, so a mount effect
   * runs while the track does not exist yet — and with an empty dependency
   * list it never runs again once it does. The height stayed 0, which floors
   * the thumb at its minimum and collapses the travel to nothing: the thumb
   * sat at the top and every drag resolved to position 0. A ref callback is
   * called with the node exactly when React attaches it.
   */
  const observerRef = useRef<ResizeObserver | null>(null);
  const measureTrack = useCallback((node: HTMLDivElement | null) => {
    trackRef.current = node;
    observerRef.current?.disconnect();
    observerRef.current = null;
    if (!node) return;
    setTrackHeight(node.clientHeight);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() =>
      setTrackHeight(node.clientHeight),
    );
    observer.observe(node);
    observerRef.current = observer;
  }, []);
  useEffect(() => () => observerRef.current?.disconnect(), []);

  const thumbPx = hasHistory
    ? Math.max(MIN_THUMB_PX, Math.round((paneHeight / total) * trackHeight))
    : trackHeight;
  const travelPx = Math.max(0, trackHeight - thumbPx);
  // Top of the track is the oldest line, so a larger position sits higher.
  const thumbTopPx = hasHistory
    ? Math.round((1 - Math.min(shown, historySize) / historySize) * travelPx)
    : 0;

  /** Turn a pointer's Y into a scroll position, thumb-centred. */
  const positionForClientY = useCallback(
    (clientY: number): number => {
      const track = trackRef.current;
      if (!track || !hasHistory || travelPx <= 0) return 0;
      const rect = track.getBoundingClientRect();
      const top = Math.min(
        travelPx,
        Math.max(0, clientY - rect.top - thumbPx / 2),
      );
      return Math.round((1 - top / travelPx) * historySize);
    },
    [hasHistory, historySize, thumbPx, travelPx],
  );

  /** Drag sends are rate-limited, but the last one must always arrive. */
  const sendDragPosition = useCallback((next: number) => {
    const now = Date.now();
    const elapsed = now - lastSend.current;
    if (sendTimer.current !== null) {
      clearTimeout(sendTimer.current);
      sendTimer.current = null;
    }
    if (elapsed >= DRAG_SEND_MS) {
      lastSend.current = now;
      scrollToPosition(next);
      return;
    }
    sendTimer.current = setTimeout(() => {
      sendTimer.current = null;
      lastSend.current = Date.now();
      scrollToPosition(next);
    }, DRAG_SEND_MS - elapsed);
  }, []);

  const handlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!hasHistory) return;
      // Pointer capture on the track, not the thumb: a drag that leaves the
      // rail sideways — which every scrollbar drag does — must keep scrolling.
      event.currentTarget.setPointerCapture(event.pointerId);
      event.preventDefault();
      const next = positionForClientY(event.clientY);
      setDragPosition(next);
      sendDragPosition(next);
    },
    [hasHistory, positionForClientY, sendDragPosition],
  );

  const handlePointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (dragPosition === null) return;
      event.preventDefault();
      const next = positionForClientY(event.clientY);
      setDragPosition(next);
      sendDragPosition(next);
    },
    [dragPosition, positionForClientY, sendDragPosition],
  );

  const endDrag = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (dragPosition === null) return;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      setDragPosition(null);
      // The relay answers every `scroll-to`, but the last one may still be in
      // the timer above; ask once more so the thumb settles on the truth.
      requestScrollState();
    },
    [dragPosition],
  );

  // No `preventDefault` here: React registers `wheel` at the root as passive,
  // so the call would only produce a console warning. Nothing needs preventing
  // anyway — the rail has no scrollable overflow of its own.
  const handleWheel = useCallback((event: React.WheelEvent<HTMLDivElement>) => {
    scrollByLines(-Math.sign(event.deltaY) * WHEEL_LINES);
  }, []);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const page = Math.max(1, paneHeight - 1);
      switch (event.key) {
        case "ArrowUp":
          scrollByLines(1);
          break;
        case "ArrowDown":
          scrollByLines(-1);
          break;
        case "PageUp":
          scrollByLines(page);
          break;
        case "PageDown":
          scrollByLines(-page);
          break;
        case "Home":
          scrollToPosition(historySize);
          break;
        case "End":
          scrollToPosition(0);
          break;
        default:
          return;
      }
      event.preventDefault();
    },
    [historySize, paneHeight],
  );

  /*
   * Nothing to draw until the relay has answered once.
   *
   * That is also the compatibility gate. The relay half of this ships in the
   * `mtmux` CLI, which the user upgrades on their own schedule, so a machine
   * running an older one never sends a `tmux:scroll-state` — and a rail with
   * no geometry behind it would be a scrollbar that does nothing. The hooks
   * above still run, so the probe that decides this is still sent.
   */
  if (!sessionName || !known) return null;

  return (
    <div
      role="scrollbar"
      aria-label="Terminal history"
      aria-orientation="vertical"
      aria-valuemin={0}
      aria-valuemax={Math.max(0, historySize)}
      aria-valuenow={Math.max(0, historySize - shown)}
      tabIndex={0}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onWheel={handleWheel}
      onKeyDown={handleKeyDown}
      onMouseEnter={requestScrollState}
      className={cn(
        // `touch-none` for the same reason every scrollbar has it: the drag is
        // ours, and letting the UA start a pan first makes preventDefault a
        // no-op on iOS. It is also why this is a *sibling* of the gesture
        // surface — `touch-action` cannot be given back inside one.
        "group absolute inset-y-0 right-0 z-[var(--z-banner)] flex w-4 touch-none",
        "select-none justify-center py-0.5",
        hasHistory ? "cursor-pointer" : "cursor-default",
        className,
      )}
      data-gesture-passthrough
    >
      {/*
        Back to the live end, in one tap.
        
        Getting out of the history was previously a drag all the way down the
        rail, or enough flings to reach the bottom — and on a phone, with a
        thumb, over a network round trip per burst. Only rendered while the
        view is actually in the past, so it costs nothing the rest of the time.
      */}
      {shown > 0 && (
        <button
          type="button"
          aria-label="Jump to latest output"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            scrollToPosition(0);
          }}
          className="absolute bottom-2 right-5 flex h-9 w-9 items-center justify-center rounded-full border border-border bg-background/90 text-muted-foreground shadow-sm backdrop-blur transition-colors hover:text-foreground"
        >
          <ChevronDown className="h-4 w-4" />
        </button>
      )}
      <div
        ref={measureTrack}
        className="relative w-1.5 rounded-full bg-border/40 transition-colors group-hover:bg-border/70"
      >
        <div
          className={cn(
            "absolute inset-x-0 rounded-full transition-colors",
            dragPosition !== null
              ? "bg-primary"
              : shown > 0
                ? "bg-primary/70"
                : "bg-border group-hover:bg-muted-foreground/60",
          )}
          style={{ top: thumbTopPx, height: thumbPx }}
        />
      </div>
    </div>
  );
}
