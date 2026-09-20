"use client";

import { useCallback, useEffect, useRef } from "react";
import { cn } from "@repo/ui/lib/utils";
import { triggerHaptic } from "@repo/ui/components/haptic-button";
import { getRelayClient } from "@/hooks/use-websocket";
import { getTerminalHandle } from "@/components/terminal/terminal-handle";
import { believedInCopyMode, noteLeftCopyMode } from "@/lib/copy-mode-belief";
import {
  flushScroll,
  resetPendingScroll,
  scrollByLines,
} from "@/lib/terminal-scroll";
import { stepStrip } from "@/lib/strip-controller";
import { useSessionStore } from "@/stores/session-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useTerminalStore } from "@/stores/terminal-store";
import { paneAtPoint } from "@/lib/pane-hit-test";
import { usePaneStore } from "@/stores/pane-store";
import { useUiStore } from "@/stores/ui-store";
import {
  initialGestureState,
  LONG_PRESS_MS,
  reduceGesture,
  type GestureConfig,
  type GestureEffect,
  type GestureState,
  type GestureTouch,
} from "@/lib/touch-gestures";

interface TerminalGestureSurfaceProps {
  children: React.ReactNode;
  className?: string;
}

/** Matches the range the settings panel offers. */
const MIN_FONT_SIZE = 8;
const MAX_FONT_SIZE = 24;

/** Used only when the renderer has not measured a cell yet. */
const FALLBACK_CELL_PX = 17;

/** How far a swipe drags the pane before it is released, visually. */
const SWIPE_FADE_START_PX = 50;

/**
 * How much of its speed a fling keeps per frame.
 *
 * 0.94 at 60fps is a little under three seconds to a standstill from a hard
 * throw, which is roughly what a native list does. Applied per elapsed frame
 * rather than per tick, so a slow frame decays by the right amount instead of
 * making the fling last longer on a busy device.
 */
const FLING_DECAY_PER_FRAME = 0.94;

/** Below this the fling has arrived; anything less is a rounding error. */
const FLING_STOP_VELOCITY = 0.05;

/** A fling never outlives this, whatever the arithmetic says. */
const FLING_MAX_MS = 2500;

/**
 * The single place terminal touches are interpreted.
 *
 * Replaces `SwipeSessionSwitcher` and `PinchZoomHandler`, which stacked two
 * independent recognisers on the same element and produced three distinct bugs
 * in the gaps between them — see `lib/touch-gestures.ts` for what each was.
 * The decisions all live in that reducer; everything here is plumbing: DOM in,
 * effects out.
 *
 * Two properties of this element are load-bearing:
 *
 *  - **`touch-action: none`.** It is what removes the entire class of "the UA
 *    committed to a pan before JS could claim the gesture", which on iOS makes
 *    every later `preventDefault()` a no-op and was the direct cause of pinch
 *    working only sometimes. It is legitimate here because the UA has nothing
 *    to do on this surface: the relay runs a real `tmux attach-session`
 *    (`apps/relay/src/pty-bridge.ts`), so tmux owns the alternate screen, there
 *    is no scrollable overflow to pan, and page pinch-zoom is exactly what the
 *    font-size gesture replaces.
 *
 *    Note what that costs: `touch-action` is resolved by intersecting the hit
 *    element with its ancestors, so `none` here cannot be undone lower down. A
 *    descendant that needs native panning has to live outside this element, not
 *    inside it with an opt-out. `data-gesture-passthrough` stops this
 *    recognizer from *claiming* a touch — which is what a widget with its own
 *    handlers needs — but it cannot give the UA its behaviour back. Every
 *    widget that needs that today (the search bar, the FAB, the window tabs)
 *    is a sibling, and that is the reason why.
 *  - **Capture-phase, non-passive listeners.** They must run ahead of xterm's
 *    own handlers on `.xterm`, and they must be allowed to call
 *    `preventDefault`.
 *
 * There is deliberately no React state here. The swipe affordance is written
 * straight to `style`, because the old implementation kept the drag offset in
 * `useState` and re-rendered the entire terminal subtree on every `touchmove`.
 */
export function TerminalGestureSurface({
  children,
  className,
}: TerminalGestureSurfaceProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const stateRef = useRef<GestureState>(initialGestureState());

  // Coalesced like the scroll in `lib/terminal-scroll.ts`, for a different
  // reason from the relay's spawn cost: a store
  // write per event re-renders the terminal and rebuilds the WebGL character
  // atlas, which is what made the old pinch-zoom strobe.
  const pendingFontSize = useRef<number | null>(null);
  const fontRaf = useRef<number | null>(null);
  /** Font size and scale the current pinch is measured from. */
  const pinchBaseline = useRef<{ font: number; scale: number } | null>(null);

  /** Handle for the running fling, so a new touch can stop it. */
  const flingRaf = useRef<number | null>(null);

  const stopFling = useCallback(() => {
    if (flingRaf.current === null) return;
    cancelAnimationFrame(flingRaf.current);
    flingRaf.current = null;
    flushScroll();
  }, []);

  /*
   * Coast after a released drag.
   *
   * The lines are accumulated as a float and only whole ones are sent, so a
   * decaying fling keeps emitting long after each individual frame is worth
   * less than a line — dropping the remainder per frame would have it stop
   * roughly a third of the way in. `scrollByLines` coalesces on its own timer,
   * so this does not become a message per frame.
   */
  const startFling = useCallback(
    (velocity: number) => {
      stopFling();
      const cell = getTerminalHandle()?.getCellHeightPx() || FALLBACK_CELL_PX;
      let speed = velocity;
      let residue = 0;
      let last = performance.now();
      const startedAt = last;

      const step = (now: number) => {
        flingRaf.current = null;
        // Capped: a backgrounded tab can hand back a multi-second gap, and
        // uncapped that is one enormous jump the instant the user returns.
        const elapsed = Math.min(50, Math.max(1, now - last));
        last = now;
        speed *= Math.pow(FLING_DECAY_PER_FRAME, elapsed / (1000 / 60));
        if (
          Math.abs(speed) < FLING_STOP_VELOCITY ||
          now - startedAt > FLING_MAX_MS
        ) {
          flushScroll();
          return;
        }
        residue += (speed * elapsed) / cell;
        const whole = Math.trunc(residue);
        residue -= whole;
        if (whole !== 0) scrollByLines(whole);
        flingRaf.current = requestAnimationFrame(step);
      };

      flingRaf.current = requestAnimationFrame(step);
    },
    [stopFling],
  );

  useEffect(() => () => stopFling(), [stopFling]);

  const flushFontSize = useCallback(() => {
    fontRaf.current = null;
    const size = pendingFontSize.current;
    pendingFontSize.current = null;
    if (size === null) return;
    if (useTerminalStore.getState().fontSize === size) return;
    useTerminalStore.getState().setFontSize(size);
  }, []);

  const switchTarget = useCallback((direction: "left" | "right") => {
    // "right" is the finger's direction of travel, so it moves to the previous
    // entry — the same mapping the old switcher had.
    //
    // Everything else about the decision lives in `resolveStrip`, which is the
    // same function the tab strip renders from. That shared derivation is the
    // fix for "the dot moves but the view doesn't": this used to step panes
    // out of an unscoped, all-windows pane list while the dots drew something
    // else entirely.
    stepStrip(direction === "right" ? -1 : 1);
  }, []);

  /**
   * Turn the press point into a pane, and open its menu.
   *
   * Falling back to the active pane rather than doing nothing: a press that
   * lands on the status line or a pane border is still a deliberate press, and
   * "nothing happened" is the failure mode this gesture is meant to remove.
   * With no pane list at all there is nothing to show, so it stays quiet.
   */
  const openPaneMenu = useCallback((x: number, y: number) => {
    const { panes, zoomedPaneId, activePaneId } = usePaneStore.getState();
    if (panes.length === 0) return;
    const grid = getTerminalHandle()?.getGeometry() ?? null;
    const hit = grid ? paneAtPoint({ x, y }, grid, panes, zoomedPaneId) : null;
    const id = hit?.id ?? activePaneId ?? panes[0]?.id ?? null;
    if (!id) return;
    if (useSettingsStore.getState().hapticEnabled) triggerHaptic();
    useUiStore.getState().setPaneMenuId(id);
  }, []);

  const applyEffects = useCallback(
    (effects: GestureEffect[]) => {
      for (const effect of effects) {
        switch (effect.type) {
          case "claim":
            // A drag is not a selection. Clearing here is what unsticks the
            // selection the search addon leaves behind — and it is safe
            // precisely because a tap never reaches this point.
            getTerminalHandle()?.clearSelection();
            break;

          case "scrollStart":
            // Anything a previous burst left pending described a different
            // drag, and this one starts from where the pane is now.
            resetPendingScroll();
            break;

          case "fling":
            startFling(effect.velocity);
            break;

          case "scroll":
            scrollByLines(effect.lines);
            break;

          case "scrollEnd":
            flushScroll();
            break;

          case "zoom": {
            // Rebase on the first zoom of a pinch: the reducer's slop means
            // the first scale it reports is already ~8% away from 1, and
            // applying that directly would make the font jump before it moves.
            const baseline =
              pinchBaseline.current ??
              (pinchBaseline.current = {
                font: useTerminalStore.getState().fontSize,
                scale: effect.scale,
              });
            const size = Math.round(
              Math.min(
                MAX_FONT_SIZE,
                Math.max(
                  MIN_FONT_SIZE,
                  baseline.font * (effect.scale / baseline.scale),
                ),
              ),
            );
            pendingFontSize.current = size;
            if (fontRaf.current === null) {
              fontRaf.current = requestAnimationFrame(flushFontSize);
            }
            break;
          }

          case "zoomEnd":
            pinchBaseline.current = null;
            break;

          case "swipeCommit":
            switchTarget(effect.direction);
            break;

          case "longPress":
            openPaneMenu(effect.x, effect.y);
            break;
        }
      }
    },
    [flushFontSize, openPaneMenu, startFling, switchTarget],
  );

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    /*
     * Only the fingers that are actually on this surface.
     *
     * `TouchEvent.touches` is every contact point on the *document*, not on the
     * event target — so a thumb resting on the window tabs or holding the FAB
     * (both siblings of this element) arrived here as a second finger. A tap on
     * the terminal then looked like a two-finger pinch: it was claimed on the
     * spot, the synthesized click never happened, and the soft keyboard never
     * came up. `targetTouches` is not the fix either — it keys on
     * `event.target`, which would split a pinch whose two fingers landed on the
     * xterm canvas and on the padding around it.
     */
    const touches = (list: TouchList): GestureTouch[] =>
      Array.from(list)
        .filter((t) => t.target instanceof Node && el.contains(t.target))
        .map((t) => ({ id: t.identifier, x: t.clientX, y: t.clientY }));

    const config = (): GestureConfig => {
      const { gestures } = useSettingsStore.getState();
      return {
        dragToScroll: gestures.dragToScroll,
        pinchToZoom: gestures.pinchToZoom,
        swipeToSwitch:
          gestures.swipeToSwitchSessions || gestures.swipeToSwitchPanes,
        longPressPaneMenu: gestures.longPressPaneMenu,
        cellHeightPx:
          getTerminalHandle()?.getCellHeightPx() || FALLBACK_CELL_PX,
      };
    };

    /** Drag affordance, written straight to the DOM to avoid a re-render. */
    const paint = () => {
      const state = stateRef.current;
      if (state.phase !== "swipe") {
        el.style.opacity = "";
        return;
      }
      const dx = Math.abs(state.lastX - state.originX);
      el.style.opacity =
        dx > SWIPE_FADE_START_PX
          ? String(Math.max(0.85, 1 - (dx - SWIPE_FADE_START_PX) / 500))
          : "";
    };

    const apply = (result: ReturnType<typeof reduceGesture>, e: Event) => {
      stateRef.current = result.state;
      if (result.preventDefault && e.cancelable) e.preventDefault();
      applyEffects(result.effects);
      paint();
    };

    /*
     * The hold timer.
     *
     * Lives here rather than in the reducer because a press becoming a long
     * press is the one transition no DOM event announces — the same reason the
     * fling's decay is a `requestAnimationFrame` loop up there and not a state
     * in the machine. When it fires it does not decide anything: it *asks*,
     * and `reduceGesture` answers using what has happened to the finger since.
     */
    let holdTimer: ReturnType<typeof setTimeout> | null = null;
    const clearHold = () => {
      if (holdTimer === null) return;
      clearTimeout(holdTimer);
      holdTimer = null;
    };
    const armHold = () => {
      clearHold();
      holdTimer = setTimeout(() => {
        holdTimer = null;
        const result = reduceGesture(stateRef.current, {
          kind: "hold",
          at: performance.now(),
        });
        // No event to cancel: the timer is not a DOM callback. Everything else
        // an `apply` does still has to happen.
        stateRef.current = result.state;
        applyEffects(result.effects);
        paint();
      }, LONG_PRESS_MS);
    };

    const onStart = (e: TouchEvent) => {
      // Touching the terminal stops a fling, the way it does on every native
      // list. Without it a tap meant to catch the moving view instead landed
      // in tmux while the pane kept sliding.
      stopFling();
      const target = e.target;
      const passthrough =
        target instanceof Element &&
        target.closest("[data-gesture-passthrough]") !== null;
      apply(
        reduceGesture(stateRef.current, {
          kind: "start",
          touches: touches(e.touches),
          at: e.timeStamp,
          passthrough,
          config: config(),
        }),
        e,
      );
      // One finger, still undecided: the only shape a hold can have.
      if (stateRef.current.phase === "pending" && e.touches.length === 1) {
        armHold();
      } else {
        clearHold();
      }
    };

    const onMove = (e: TouchEvent) => {
      apply(
        reduceGesture(stateRef.current, {
          kind: "move",
          touches: touches(e.touches),
          at: e.timeStamp,
        }),
        e,
      );
      // A locked gesture owns the touch; a press still drifting inside its
      // slop keeps the timer, and the reducer re-checks the drift when it
      // fires.
      if (stateRef.current.phase !== "pending") clearHold();
    };

    const onEnd = (e: TouchEvent) => {
      clearHold();
      const wasTap = stateRef.current.phase === "pending";
      apply(
        reduceGesture(stateRef.current, {
          kind: "end",
          touches: touches(e.touches),
          changed: touches(e.changedTouches),
          at: e.timeStamp,
        }),
        e,
      );
      // Tapping the terminal after scrolling means "I want to type again", and
      // tmux does not leave copy mode on its own unless the view has reached
      // the bottom. Keystrokes in copy mode are copy-mode commands, so without
      // this the terminal looks focused and silently swallows input.
      const session = useSessionStore.getState().activeSessionId;
      if (
        wasTap &&
        touches(e.touches).length === 0 &&
        believedInCopyMode(session) &&
        getRelayClient()?.status === "connected"
      ) {
        noteLeftCopyMode(session);
        getRelayClient()?.send({ type: "tmux:exit-copy-mode" });
      }
    };

    const onCancel = (e: TouchEvent) => {
      clearHold();
      apply(
        reduceGesture(stateRef.current, { kind: "cancel", at: e.timeStamp }),
        e,
      );
    };

    // Capture so these run before xterm's own listeners, non-passive so
    // `preventDefault` is allowed at all.
    const opts = { capture: true, passive: false } as const;
    el.addEventListener("touchstart", onStart, opts);
    el.addEventListener("touchmove", onMove, opts);
    el.addEventListener("touchend", onEnd, opts);
    el.addEventListener("touchcancel", onCancel, opts);

    return () => {
      el.removeEventListener("touchstart", onStart, opts);
      el.removeEventListener("touchmove", onMove, opts);
      el.removeEventListener("touchend", onEnd, opts);
      el.removeEventListener("touchcancel", onCancel, opts);
      clearHold();
      if (fontRaf.current !== null) cancelAnimationFrame(fontRaf.current);
      fontRaf.current = null;
      el.style.opacity = "";
    };
  }, [applyEffects, stopFling]);

  return (
    <div
      ref={containerRef}
      className={cn("touch-none transition-opacity duration-75", className)}
    >
      {children}
    </div>
  );
}
