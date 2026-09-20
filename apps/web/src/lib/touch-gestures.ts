/**
 * The terminal's touch recognizer, as a pure state machine.
 *
 * ## Why one machine instead of two components
 *
 * Scrolling, session-switching and pinch-zoom used to live in two independent
 * components stacked on top of each other, each deciding on its own whether a
 * touch was its business. Every reported mobile gesture bug came out of the
 * gaps between them:
 *
 *  - **Pinch was intermittent.** The zoom handler ignored `touchstart` unless
 *    two fingers were already down, so the first finger was never claimed. The
 *    wrapper below it asked for `touch-action: pan-y`, which let the UA commit
 *    to a pan before the second finger landed — and on iOS every subsequent
 *    `touchmove` is then non-cancelable, so `preventDefault()` did nothing.
 *    Whether it worked depended on whether finger one drifted first.
 *  - **Horizontal swipe worked "occasionally".** The switcher refused any drag
 *    while xterm reported a selection, and the search addon calls
 *    `terminal.select()` on every hit while nothing in the app ever cleared it.
 *    One search on a phone latched that guard until reload.
 *  - **Vertical drag did nothing at all.** See `scroll` below.
 *
 * A single machine can decide once, with all the fingers in view, which is the
 * only way those three can stop fighting.
 *
 * ## What the phases mean
 *
 * `pending` is the undecided window: a touch is down, nothing is claimed, and
 * it may still turn out to be a tap — which must keep working, because a tap is
 * what focuses the terminal and raises the soft keyboard. From `pending` a
 * gesture locks exactly once, to `scroll`, `swipe` or `pinch`, and never
 * re-decides. `passthrough` is absorbing: it is where a gesture goes to die
 * without producing anything, which is what stops a lifted pinch finger from
 * cross-firing a session switch on the way out.
 *
 * Deliberately DOM-free, so every rule below is testable without a browser.
 */

/** One finger, reduced to what any decision here needs. */
export type GestureTouch = { id: number; x: number; y: number };

export type GestureConfig = {
  /** A one-finger vertical drag scrolls tmux history. */
  dragToScroll: boolean;
  /** A two-finger pinch changes the terminal font size. */
  pinchToZoom: boolean;
  /** A one-finger horizontal swipe moves between panes or sessions. */
  swipeToSwitch: boolean;
  /** A one-finger press that stays still opens the pane menu under it. */
  longPressPaneMenu: boolean;
  /**
   * Pixel height of one terminal row, for turning a drag into a line count.
   *
   * Latched with the rest of the config when the gesture starts: a font-size
   * change landing mid-drag would otherwise make the same finger movement mean
   * a different number of lines partway through.
   */
  cellHeightPx: number;
};

export type GestureInput =
  | {
      kind: "start";
      touches: GestureTouch[];
      at: number;
      /**
       * The touch landed on a widget that owns its own gestures — the FAB, the
       * search bar. A hit test rather than a latched flag, deliberately: the
       * bug this replaces was a guard that could survive the gesture that set
       * it, and a per-gesture hit test cannot.
       */
      passthrough?: boolean;
      config: GestureConfig;
    }
  | { kind: "move"; touches: GestureTouch[]; at: number }
  /**
   * The press has been still long enough to be a hold — ask whether it counts.
   *
   * The timer is the surface's, for the same reason the fling's decay is: this
   * reducer is pure and driven by DOM events, and a press becoming a long press
   * is the one transition no event announces. The question still has to be
   * asked *here*, because only this state knows whether the finger has since
   * drifted, locked into a scroll, or been joined by a second one.
   */
  | { kind: "hold"; at: number }
  | {
      kind: "end";
      /** Fingers still down — on `touchend` this excludes the lifted one. */
      touches: GestureTouch[];
      /**
       * The fingers that just left, i.e. `changedTouches`.
       *
       * Without it the release position is whatever the last `touchmove`
       * reported, and a fast flick that ends between move samples under-reports
       * both its distance and its velocity — biasing exactly the short, quick
       * swipes the velocity gate exists to accept.
       */
      changed?: GestureTouch[];
      at: number;
    }
  | { kind: "cancel"; at: number };

export type GestureEffect =
  /**
   * This touch is now definitely a gesture and not a tap. Fires once, at the
   * moment of locking. The surface clears any xterm selection here — a tap
   * never claims, so a selection the user is about to copy is never destroyed.
   */
  | { type: "claim" }
  | { type: "scrollStart" }
  /** Positive is back into the past, matching `tmux:scroll`. */
  | { type: "scroll"; lines: number }
  | { type: "scrollEnd" }
  /**
   * A released scroll that was still moving, in CSS px per ms.
   *
   * Positive is downward on screen, i.e. backward in time, matching `scroll`.
   * Emitted alongside `scrollEnd`, never instead of it: the flush still has to
   * happen whether or not the release was fast enough to coast.
   *
   * The decay itself is not modelled here. This reducer is pure and driven by
   * DOM events; a fling is a timer, which is the surface's job.
   */
  | { type: "fling"; velocity: number }
  /** Font size multiplier relative to the size when the pinch began. */
  | { type: "zoom"; scale: number }
  | { type: "zoomEnd" }
  /** The direction the finger travelled, not the direction of the change. */
  | { type: "swipeCommit"; direction: "left" | "right" }
  /**
   * A still press, at the point it began, in client coordinates.
   *
   * The origin rather than the last position on purpose: the point names a
   * pane, and a press allowed to drift up to the slop should open the menu for
   * the pane the finger was put down on.
   */
  | { type: "longPress"; x: number; y: number };

export type GesturePhase =
  | "idle"
  | "pending"
  | "scroll"
  | "swipe"
  | "pinch"
  /** A long press has fired; the rest of this touch does nothing. */
  | "held"
  | "passthrough";

export type GestureState = {
  phase: GesturePhase;
  config: GestureConfig | null;
  /** Identity of the finger the one-finger phases follow. */
  primaryId: number | null;
  originX: number;
  originY: number;
  startedAt: number;
  /** When the phase left `pending`. The swipe time budget runs from here. */
  lockedAt: number;
  lastX: number;
  lastY: number;
  /** Sub-line drag not yet worth a `scroll`, so slow drags still move. */
  scrollRemainder: number;
  /** Sign of the last emitted scroll, for resetting the remainder on reversal. */
  scrollDirection: 0 | 1 | -1;
  /**
   * Recent finger positions, for the release-velocity readings.
   *
   * Both axes: `x` gates the swipe, `y` sets the fling a released scroll
   * coasts on. One list rather than two because they are sampled at exactly
   * the same moments — every `touchmove` — and a second one would only be a
   * way for them to disagree.
   */
  samples: { x: number; y: number; at: number }[];
  /** Finger separation when the pinch began, in px. */
  pinchBase: number | null;
  /** True once the pinch has moved past its slop and started rebasing. */
  pinchMoved: boolean;
};

export type GestureResult = {
  state: GestureState;
  effects: GestureEffect[];
  /**
   * Whether the surface should call `preventDefault()`.
   *
   * With `touch-action: none` already denying the UA any pan or zoom, this now
   * governs only the synthesized compatibility mouse events — which are exactly
   * what gives xterm focus and raises the soft keyboard. So it stays `false`
   * for anything that might still be a tap, and turns on from the locking move
   * onward, including the `touchend` of a claimed gesture: without that last
   * one a trailing `click` lands in tmux and moves the cursor at the end of
   * every drag.
   */
  preventDefault: boolean;
};

/**
 * How far a finger travels before the axis is decided, in CSS pixels.
 *
 * Between Android's 8dp touch slop and iOS's ~10pt, and under one terminal cell
 * width at the default font size — so the decision is made on movement a user
 * meant, but before enough of it has happened to feel laggy.
 */
export const AXIS_LOCK_PX = 12;

/**
 * How much more horizontal than vertical a drag must be to count as a swipe.
 *
 * Asymmetric on purpose. The ambiguous band between the two axes goes to
 * scrolling, because the costs are not symmetric: a scroll the user did not
 * want costs a line and is undone by dragging back, while a session switch they
 * did not want takes them somewhere else entirely and has to be hunted back.
 */
export const HORIZONTAL_RATIO = 1.3;

/** A swipe this far commits regardless of how slowly it ended. */
export const SWIPE_FAR_PX = 120;
/** A shorter swipe commits only if it was still moving when it was released. */
export const SWIPE_MIN_PX = 64;
export const SWIPE_MIN_VELOCITY = 0.3;
/** Velocity is measured over the tail of the gesture, not its whole length. */
export const SWIPE_VELOCITY_WINDOW_MS = 100;
/**
 * A drag longer than this is a considered movement, not a flick.
 *
 * The old code had no time bound at all, so a finger resting on the terminal
 * for ten seconds and then lifting 100px to the left switched sessions.
 */
export const SWIPE_MAX_MS = 800;

/**
 * How long a finger must stay down, and how far it may stray, to be a hold.
 *
 * 500ms is what the FAB already uses for its own long press, and what both
 * platforms use for a context menu, so the gesture feels the same everywhere in
 * the app. The slop is under `AXIS_LOCK_PX` by design: a press that has moved
 * far enough to be deciding an axis is a drag that started slowly, not a hold,
 * and the axis lock must stay the thing that claims it.
 */
export const LONG_PRESS_MS = 500;
export const LONG_PRESS_SLOP_PX = 10;

/** Scale change that must accumulate before a pinch starts zooming. */
export const PINCH_SLOP = 0.08;

/**
 * Slowest release that still coasts, in CSS px per ms.
 *
 * Below this the finger was being placed, not thrown, and a fling would move
 * the view out from under a user who had just found the line they wanted.
 */
export const FLING_MIN_VELOCITY = 0.35;

/** Older samples than this are useless for a release velocity. */
const SAMPLE_KEEP_MS = 300;

export function initialGestureState(): GestureState {
  return {
    phase: "idle",
    config: null,
    primaryId: null,
    originX: 0,
    originY: 0,
    startedAt: 0,
    lockedAt: 0,
    lastX: 0,
    lastY: 0,
    scrollRemainder: 0,
    scrollDirection: 0,
    samples: [],
    pinchBase: null,
    pinchMoved: false,
  };
}

function distance(a: GestureTouch, b: GestureTouch): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * The finger this gesture is following, by identity — never by position.
 *
 * There used to be a `?? touches[0]` fallback here, and it was wrong in a way
 * that reversed gestures: with a second finger anywhere on the screen, lifting
 * the one that was actually swiping made the fallback hand back the *other*
 * finger, and its x was then measured against the departed finger's origin. A
 * 50px swipe left committed 600px to the right. If the primary is gone, the
 * answer is "no touch", and the caller decides what that means.
 */
function primary(
  state: GestureState,
  touches: GestureTouch[],
): GestureTouch | null {
  return touches.find((t) => t.id === state.primaryId) ?? null;
}

function pushSample(
  samples: GestureState["samples"],
  x: number,
  y: number,
  at: number,
): GestureState["samples"] {
  return [...samples, { x, y, at }].filter((s) => at - s.at <= SAMPLE_KEEP_MS);
}

/**
 * Signed px/ms over the tail of the gesture, or 0 with nothing to measure.
 *
 * Signed, not absolute: a user who swipes right and then pulls back to cancel
 * is moving fast at the moment of release, and an unsigned reading counted that
 * as a confident flick in the direction they had just abandoned.
 */
function releaseVelocity(
  samples: GestureState["samples"],
  x: number,
  at: number,
): number {
  const oldest = samples.find((s) => at - s.at <= SWIPE_VELOCITY_WINDOW_MS);
  if (!oldest) return 0;
  const dt = at - oldest.at;
  if (dt <= 0) return 0;
  return (x - oldest.x) / dt;
}

/**
 * The same reading on the vertical axis, for a released scroll.
 *
 * Positive is downward on screen, which is backward in time — the same sign
 * convention `scroll` effects use, so the surface can hand it straight on.
 */
function releaseVelocityY(
  samples: GestureState["samples"],
  y: number,
  at: number,
): number {
  const oldest = samples.find((s) => at - s.at <= SWIPE_VELOCITY_WINDOW_MS);
  if (!oldest) return 0;
  const dt = at - oldest.at;
  if (dt <= 0) return 0;
  return (y - oldest.y) / dt;
}

/** Whether a released swipe is one the user meant. */
export function swipeCommits(
  state: GestureState,
  x: number,
  at: number,
): "left" | "right" | null {
  const dx = x - state.originX;
  if (at - state.lockedAt > SWIPE_MAX_MS) return null;
  const far = Math.abs(dx) >= SWIPE_FAR_PX;
  const velocity = releaseVelocity(state.samples, x, at);
  const flick =
    Math.abs(dx) >= SWIPE_MIN_PX &&
    Math.abs(velocity) >= SWIPE_MIN_VELOCITY &&
    // Still travelling the way it came. A finger that has turned around is
    // taking the gesture back, however quickly it is doing it.
    Math.sign(velocity) === Math.sign(dx);
  if (!far && !flick) return null;
  return dx > 0 ? "right" : "left";
}

function enterPinch(
  state: GestureState,
  touches: GestureTouch[],
  at: number,
  claimed: boolean,
): GestureResult {
  const [a, b] = touches;
  if (!a || !b) return { state, effects: [], preventDefault: true };
  const effects: GestureEffect[] = [];
  if (!claimed) effects.push({ type: "claim" });
  if (state.phase === "scroll") effects.push({ type: "scrollEnd" });
  return {
    state: {
      ...state,
      phase: "pinch",
      lockedAt: state.phase === "pending" ? at : state.lockedAt,
      pinchBase: distance(a, b),
      pinchMoved: false,
      scrollRemainder: 0,
      scrollDirection: 0,
    },
    effects,
    preventDefault: true,
  };
}

/** True for the phases that have already taken the touch away from the page. */
function claimedPhase(phase: GesturePhase): boolean {
  return phase === "scroll" || phase === "swipe" || phase === "pinch";
}

export function reduceGesture(
  state: GestureState,
  input: GestureInput,
): GestureResult {
  switch (input.kind) {
    case "start":
      return onStart(state, input);
    case "move":
      return onMove(state, input);
    case "end":
      return onEnd(state, input);
    case "hold":
      return onHold(state);
    case "cancel":
      return onCancel(state);
  }
}

/**
 * The timer fired. Whether that means anything is this function's answer.
 *
 * Only from `pending`, and only for a finger that has barely moved: by the
 * time a gesture has locked, the touch belongs to it, and firing a menu out
 * from under a slow scroll is exactly the kind of surprise that makes people
 * stop trusting a gesture surface.
 */
function onHold(state: GestureState): GestureResult {
  if (state.phase !== "pending" || !state.config?.longPressPaneMenu) {
    return { state, effects: [], preventDefault: false };
  }
  const drift = Math.hypot(
    state.lastX - state.originX,
    state.lastY - state.originY,
  );
  if (drift > LONG_PRESS_SLOP_PX) {
    return { state, effects: [], preventDefault: false };
  }
  return {
    state: { ...state, phase: "held" },
    effects: [{ type: "longPress", x: state.originX, y: state.originY }],
    preventDefault: false,
  };
}

function onStart(
  state: GestureState,
  input: Extract<GestureInput, { kind: "start" }>,
): GestureResult {
  // A gesture already in flight keeps its own config and its own decision; a
  // second finger is handled by `move`, not by restarting here.
  if (state.phase === "pinch" || state.phase === "passthrough") {
    return { state, effects: [], preventDefault: claimedPhase(state.phase) };
  }

  // A second finger on a press the menu already answered. The touch is spent.
  if (state.phase === "held") {
    return { state, effects: [], preventDefault: true };
  }

  const first = input.touches[0];
  if (!first) return { state, effects: [], preventDefault: false };

  if (input.passthrough) {
    return {
      state: { ...initialGestureState(), phase: "passthrough" },
      effects: [],
      preventDefault: false,
    };
  }

  /*
   * A second finger landing on a gesture that has already locked.
   *
   * Falling through to `fresh` below — which is what used to happen — threw
   * away the accumulated drag and dropped the phase back to `pending`, so a
   * mid-scroll second finger silently unlocked the scroll. With pinch enabled
   * it was worse: `enterPinch` was handed the *fresh* state, so its
   * `state.phase === "scroll"` test read `pending`, no `scrollEnd` was emitted,
   * and `claim` fired a second time for one gesture.
   */
  if (claimedPhase(state.phase)) {
    if (input.touches.length >= 2 && state.config?.pinchToZoom) {
      return enterPinch(state, input.touches, input.at, true);
    }
    return { state, effects: [], preventDefault: true };
  }

  const fresh: GestureState = {
    ...initialGestureState(),
    phase: "pending",
    config: input.config,
    primaryId: first.id,
    originX: first.x,
    originY: first.y,
    startedAt: input.at,
    lastX: first.x,
    lastY: first.y,
    samples: [{ x: first.x, y: first.y, at: input.at }],
  };

  // Two fingers down at once is never a tap, so this can be claimed on the
  // spot — which is the half the old handler got right.
  if (input.touches.length >= 2 && input.config.pinchToZoom) {
    return enterPinch(fresh, input.touches, input.at, false);
  }

  return { state: fresh, effects: [], preventDefault: false };
}

function onMove(
  state: GestureState,
  input: Extract<GestureInput, { kind: "move" }>,
): GestureResult {
  if (state.phase === "idle" || state.phase === "passthrough") {
    return { state, effects: [], preventDefault: false };
  }

  // Held: the menu is up and this finger is done. `preventDefault` so the
  // drag that follows a long press is not also delivered to tmux as a click.
  if (state.phase === "held") {
    return { state, effects: [], preventDefault: true };
  }

  const config = state.config;
  if (!config) return { state, effects: [], preventDefault: false };

  if (state.phase === "pinch") {
    return pinchMove(state, input);
  }

  // A second finger arriving mid-gesture. This transition is the pinch bug:
  // the old handler could only start a pinch from rest, so a pinch that began
  // with one finger already drifting was simply never recognised.
  if (input.touches.length >= 2 && config.pinchToZoom) {
    return enterPinch(
      state,
      input.touches,
      input.at,
      claimedPhase(state.phase),
    );
  }

  const touch = primary(state, input.touches);
  if (!touch) {
    return { state, effects: [], preventDefault: claimedPhase(state.phase) };
  }

  const samples = pushSample(state.samples, touch.x, touch.y, input.at);

  if (state.phase === "pending") {
    return pendingMove(state, touch, input.at, samples, config);
  }

  if (state.phase === "swipe") {
    return {
      state: { ...state, lastX: touch.x, lastY: touch.y, samples },
      effects: [],
      preventDefault: true,
    };
  }

  return scrollMove(state, touch, samples, config);
}

function pendingMove(
  state: GestureState,
  touch: GestureTouch,
  at: number,
  samples: GestureState["samples"],
  config: GestureConfig,
): GestureResult {
  const dx = touch.x - state.originX;
  const dy = touch.y - state.originY;
  if (Math.hypot(dx, dy) < AXIS_LOCK_PX) {
    return {
      state: { ...state, lastX: touch.x, lastY: touch.y, samples },
      effects: [],
      preventDefault: false,
    };
  }

  const horizontal = Math.abs(dx) >= Math.abs(dy) * HORIZONTAL_RATIO;
  const wanted = horizontal ? config.swipeToSwitch : config.dragToScroll;
  if (!wanted) {
    // The gesture is understood and switched off. Absorbing rather than
    // falling back to the other axis: a user who turned swiping off wants a
    // horizontal drag to do nothing, not to scroll.
    return {
      state: { ...state, phase: "passthrough" },
      effects: [],
      preventDefault: false,
    };
  }

  const locked: GestureState = {
    ...state,
    phase: horizontal ? "swipe" : "scroll",
    lockedAt: at,
    lastX: touch.x,
    // Scrolling measures from where the axis was decided, so the slop the lock
    // consumed is not also counted as history to travel.
    lastY: touch.y,
    samples,
  };
  const effects: GestureEffect[] = [{ type: "claim" }];
  if (!horizontal) effects.push({ type: "scrollStart" });
  return { state: locked, effects, preventDefault: true };
}

function scrollMove(
  state: GestureState,
  touch: GestureTouch,
  samples: GestureState["samples"],
  config: GestureConfig,
): GestureResult {
  const cell = config.cellHeightPx > 0 ? config.cellHeightPx : 17;
  // Dragging down reveals older output, the way content follows a finger
  // everywhere else on a phone. `tmux:scroll` counts positive as back in time.
  const delta = (touch.y - state.lastY) / cell;
  const moved: 0 | 1 | -1 = delta > 0 ? 1 : delta < 0 ? -1 : 0;

  /*
   * A reversal starts its own sub-line budget.
   *
   * Keyed on the direction the finger is *moving*, not on the last line
   * emitted. Deciding it from the emitted line meant the first sub-line step
   * back was added to the old direction's remainder — so a reversal spent up to
   * a line and a half paying that off before anything moved, and a user who
   * dragged back a little watched the screen ignore them.
   */
  const reversed =
    moved !== 0 &&
    state.scrollDirection !== 0 &&
    moved !== state.scrollDirection;
  const raw = delta + (reversed ? 0 : state.scrollRemainder);
  const lines = Math.trunc(raw);
  const scrollDirection = moved !== 0 ? moved : state.scrollDirection;

  return {
    state: {
      ...state,
      lastX: touch.x,
      lastY: touch.y,
      scrollRemainder: raw - lines,
      scrollDirection,
      samples,
    },
    effects: lines === 0 ? [] : [{ type: "scroll", lines }],
    preventDefault: true,
  };
}

function pinchMove(
  state: GestureState,
  input: Extract<GestureInput, { kind: "move" }>,
): GestureResult {
  const [a, b] = input.touches;
  if (!a || !b || state.pinchBase === null) {
    return { state, effects: [], preventDefault: true };
  }
  const now = distance(a, b);
  if (state.pinchBase <= 0) {
    return {
      state: { ...state, pinchBase: now },
      effects: [],
      preventDefault: true,
    };
  }
  const scale = now / state.pinchBase;
  // Slop before the first zoom, so resting two fingers on the screen does not
  // nudge the font size. Once it has moved, every frame counts.
  if (!state.pinchMoved && Math.abs(scale - 1) < PINCH_SLOP) {
    return { state, effects: [], preventDefault: true };
  }
  return {
    state: { ...state, pinchMoved: true },
    effects: [{ type: "zoom", scale }],
    preventDefault: true,
  };
}

function onEnd(
  state: GestureState,
  input: Extract<GestureInput, { kind: "end" }>,
): GestureResult {
  const remaining = input.touches.length;

  if (state.phase === "passthrough") {
    return {
      state: remaining > 0 ? state : initialGestureState(),
      effects: [],
      preventDefault: false,
    };
  }

  if (state.phase === "held") {
    // Cancel the synthesized click. Without it the lift lands in tmux, moving
    // the cursor or clicking a link in whatever is running, behind a menu the
    // user is still reading.
    return {
      state: remaining > 0 ? state : initialGestureState(),
      effects: [],
      preventDefault: true,
    };
  }

  if (state.phase === "idle") {
    return { state, effects: [], preventDefault: false };
  }

  if (state.phase === "pinch") {
    // Absorbing, not "back to one-finger mode". Letting the surviving finger
    // fall through to the swipe recogniser is how a pinch used to end up
    // switching sessions on the way out.
    return {
      state:
        remaining > 0
          ? { ...initialGestureState(), phase: "passthrough" }
          : initialGestureState(),
      effects: [{ type: "zoomEnd" }],
      preventDefault: true,
    };
  }

  const primaryStillDown = input.touches.some((t) => t.id === state.primaryId);

  if (state.phase === "pending") {
    // A tap. Nothing claimed, nothing prevented — this is what leaves the
    // synthesized click alone so xterm takes focus and the keyboard comes up.
    if (remaining === 0) {
      return {
        state: initialGestureState(),
        effects: [],
        preventDefault: false,
      };
    }
    if (primaryStillDown) {
      return { state, effects: [], preventDefault: false };
    }
    /*
     * The finger the machine was following lifted while others are still down.
     *
     * Keeping its origin would measure a *different* finger's movement from the
     * departed one's starting point, so two pixels of drift read as a
     * two-hundred-pixel swipe and committed a session switch. Re-anchoring
     * makes the survivor a gesture in its own right, with its own slop to earn.
     */
    const next = input.touches[0];
    if (!next) {
      return {
        state: initialGestureState(),
        effects: [],
        preventDefault: false,
      };
    }
    return {
      state: {
        ...state,
        primaryId: next.id,
        originX: next.x,
        originY: next.y,
        startedAt: input.at,
        lastX: next.x,
        lastY: next.y,
        scrollRemainder: 0,
        scrollDirection: 0,
        samples: [{ x: next.x, y: next.y, at: input.at }],
      },
      effects: [],
      preventDefault: false,
    };
  }

  /*
   * Some other finger left; the one being followed is still dragging.
   *
   * This used to end the gesture outright on any `touchend`, which — because
   * `TouchEvent.touches` is document-wide — meant lifting a thumb from the tab
   * bar killed a scroll mid-drag. Worse, it killed it into `idle`, where every
   * further `touchmove` was discarded, so the scroll could not restart until
   * the user lifted and touched again.
   */
  if (primaryStillDown) {
    return { state, effects: [], preventDefault: true };
  }

  if (state.phase === "scroll") {
    /*
     * Coast, if the finger was still travelling when it left.
     *
     * Dragging was strictly 1:1 with the finger and stopped dead on release,
     * so covering a long history meant a dozen full-screen drags. Every other
     * scrolling surface on a phone flings; this one felt broken next to them.
     *
     * Measured from `changedTouches` where the browser gives it, for the
     * reason the swipe gate already documents: a fast flick that ends between
     * move samples under-reports its own speed.
     */
    const lifted = input.changed?.find((t) => t.id === state.primaryId);
    const y = lifted?.y ?? state.lastY;
    const samples = lifted
      ? pushSample(state.samples, lifted.x, lifted.y, input.at)
      : state.samples;
    const velocity = releaseVelocityY(samples, y, input.at);
    const effects: GestureEffect[] = [{ type: "scrollEnd" }];
    if (Math.abs(velocity) >= FLING_MIN_VELOCITY) {
      effects.push({ type: "fling", velocity });
    }
    return {
      state:
        remaining > 0
          ? { ...initialGestureState(), phase: "passthrough" }
          : initialGestureState(),
      effects,
      preventDefault: true,
    };
  }

  // Where the finger actually left, when the browser told us; the last move
  // sample otherwise.
  const lifted = input.changed?.find((t) => t.id === state.primaryId);
  const x = lifted?.x ?? state.lastX;
  const released = lifted
    ? {
        ...state,
        samples: pushSample(state.samples, lifted.x, lifted.y, input.at),
      }
    : state;
  const direction = swipeCommits(released, x, input.at);
  return {
    state:
      remaining > 0
        ? { ...initialGestureState(), phase: "passthrough" }
        : initialGestureState(),
    effects: direction ? [{ type: "swipeCommit", direction }] : [],
    // Prevented either way: the drag happened, and the trailing click it would
    // otherwise synthesize would land in tmux.
    preventDefault: true,
  };
}

function onCancel(state: GestureState): GestureResult {
  const effects: GestureEffect[] = [];
  if (state.phase === "scroll") effects.push({ type: "scrollEnd" });
  if (state.phase === "pinch") effects.push({ type: "zoomEnd" });
  return {
    state: initialGestureState(),
    effects,
    preventDefault: claimedPhase(state.phase),
  };
}
