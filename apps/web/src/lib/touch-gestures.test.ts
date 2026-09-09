import { describe, it, expect } from "vitest";
import {
  AXIS_LOCK_PX,
  initialGestureState,
  reduceGesture,
  type GestureConfig,
  type GestureEffect,
  type GestureInput,
  type GestureState,
  type GestureTouch,
} from "./touch-gestures";

const CELL = 17;

const CONFIG: GestureConfig = {
  dragToScroll: true,
  pinchToZoom: true,
  swipeToSwitch: true,
  cellHeightPx: CELL,
};

/**
 * Drive the machine the way the DOM does, and keep everything it produced.
 *
 * Every assertion below is about a sequence, because every one of the three
 * reported bugs was a sequence bug — a decision taken at the wrong moment, or
 * taken once and never revisited.
 */
function run(inputs: GestureInput[], from?: GestureState) {
  let state = from ?? initialGestureState();
  const effects: GestureEffect[] = [];
  const prevented: boolean[] = [];
  for (const input of inputs) {
    const result = reduceGesture(state, input);
    state = result.state;
    effects.push(...result.effects);
    prevented.push(result.preventDefault);
  }
  return {
    state,
    effects,
    prevented,
    of: (type: GestureEffect["type"]) => effects.filter((e) => e.type === type),
  };
}

const down = (x: number, y: number, at = 0): GestureInput => ({
  kind: "start",
  touches: [{ id: 1, x, y }],
  at,
  config: CONFIG,
});

const move = (x: number, y: number, at: number): GestureInput => ({
  kind: "move",
  touches: [{ id: 1, x, y }],
  at,
});

const up = (at: number): GestureInput => ({ kind: "end", touches: [], at });

/** A `touchend` that names which fingers left and which are still down. */
const lift = (
  at: number,
  opts: { still?: GestureTouch[]; changed?: GestureTouch[] } = {},
): GestureInput => ({
  kind: "end",
  touches: opts.still ?? [],
  ...(opts.changed ? { changed: opts.changed } : {}),
  at,
});

/** A straight drag in `steps` equal moves, so continuity can be observed. */
function drag(
  from: { x: number; y: number },
  to: { x: number; y: number },
  opts: { steps?: number; durationMs?: number } = {},
): GestureInput[] {
  const steps = opts.steps ?? 10;
  const duration = opts.durationMs ?? 200;
  const inputs: GestureInput[] = [down(from.x, from.y, 0)];
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    inputs.push(
      move(
        from.x + (to.x - from.x) * t,
        from.y + (to.y - from.y) * t,
        duration * t,
      ),
    );
  }
  inputs.push(up(duration));
  return inputs;
}

describe("a tap", () => {
  it("produces nothing and prevents nothing", () => {
    // The contract that keeps the terminal focusable and the soft keyboard
    // reachable: `preventDefault` on any of these kills the synthesized click.
    const r = run([down(100, 100, 0), move(101, 100, 40), up(60)]);
    expect(r.effects).toEqual([]);
    expect(r.prevented).toEqual([false, false, false]);
    expect(r.state.phase).toBe("idle");
  });

  it("stays a tap right up to the slop boundary", () => {
    const r = run([down(100, 100, 0), move(100, 100 + AXIS_LOCK_PX - 1, 30)]);
    expect(r.effects).toEqual([]);
    expect(r.state.phase).toBe("pending");
  });
});

describe("vertical drag — the swipe that did nothing", () => {
  /**
   * The bug: tmux holds the alternate screen, so xterm's scrollback is empty
   * and there was nothing for either xterm or the UA to move. A vertical drag
   * has to become a `tmux:scroll`, and it has to do so continuously — one
   * batched scroll at the end of the drag is not scrolling.
   */
  it("scrolls tmux history and never fires a swipe", () => {
    const r = run(drag({ x: 200, y: 100 }, { x: 200, y: 400 }));
    expect(r.of("scrollStart")).toHaveLength(1);
    expect(r.of("scrollEnd")).toHaveLength(1);
    expect(r.of("swipeCommit")).toEqual([]);
    expect(r.of("scroll").length).toBeGreaterThanOrEqual(3);
  });

  it("emits its lines during the drag, not at the end of it", () => {
    const inputs = drag({ x: 200, y: 100 }, { x: 200, y: 400 });
    const beforeRelease = run(inputs.slice(0, -1));
    expect(beforeRelease.of("scroll").length).toBeGreaterThanOrEqual(3);
  });

  it("moves about as many lines as the finger covered cells", () => {
    const total = 300;
    const r = run(drag({ x: 200, y: 100 }, { x: 200, y: 100 + total }));
    const lines = r
      .of("scroll")
      .reduce((n, e) => n + (e.type === "scroll" ? e.lines : 0), 0);
    // The slop the axis lock consumed is not travelled, so allow a cell of
    // slack either way — what matters is that it is not off by a factor.
    const expected = Math.trunc((total - AXIS_LOCK_PX) / CELL);
    expect(Math.abs(lines - expected)).toBeLessThanOrEqual(1);
  });

  it("goes back the other way on an upward drag", () => {
    const r = run(drag({ x: 200, y: 400 }, { x: 200, y: 100 }));
    const lines = r
      .of("scroll")
      .reduce((n, e) => n + (e.type === "scroll" ? e.lines : 0), 0);
    expect(lines).toBeLessThan(0);
  });

  it("accumulates sub-line movement instead of dropping it", () => {
    // Ten moves of four pixels is well under a cell each and must still scroll.
    const inputs: GestureInput[] = [down(200, 100, 0)];
    for (let i = 1; i <= 20; i++) inputs.push(move(200, 100 + i * 4, i * 10));
    inputs.push(up(200));
    const lines = run(inputs)
      .of("scroll")
      .reduce((n, e) => n + (e.type === "scroll" ? e.lines : 0), 0);
    expect(lines).toBeGreaterThan(0);
  });

  it("ignores a large horizontal excursion once it has locked to scrolling", () => {
    const r = run([
      down(200, 100, 0),
      move(200, 160, 40),
      move(600, 200, 120),
      up(160),
    ]);
    expect(r.of("swipeCommit")).toEqual([]);
    expect(r.of("scroll").length).toBeGreaterThan(0);
  });
});

describe("pinch — the zoom that sometimes did nothing", () => {
  /**
   * The bug: the old handler ignored `touchstart` unless two fingers were
   * already down, so a pinch whose first finger had drifted at all was never
   * recognised — and under `touch-action: pan-y` iOS had already committed to
   * a pan, making `preventDefault` a no-op for the rest of the gesture.
   */
  it("starts from two fingers down at once", () => {
    const r = run([
      {
        kind: "start",
        touches: [
          { id: 1, x: 100, y: 200 },
          { id: 2, x: 200, y: 200 },
        ],
        at: 0,
        config: CONFIG,
      },
      {
        kind: "move",
        touches: [
          { id: 1, x: 50, y: 200 },
          { id: 2, x: 250, y: 200 },
        ],
        at: 40,
      },
    ]);
    expect(r.state.phase).toBe("pinch");
    expect(r.of("zoom")).toHaveLength(1);
    expect(r.prevented.every(Boolean)).toBe(true);
  });

  it("still starts when the first finger has already been dragging", () => {
    const r = run([
      down(100, 200, 0),
      move(100, 230, 30), // locked to scroll — 30px is well past the slop
      {
        kind: "move",
        touches: [
          { id: 1, x: 100, y: 230 },
          { id: 2, x: 200, y: 230 },
        ],
        at: 60,
      },
      {
        kind: "move",
        touches: [
          { id: 1, x: 60, y: 230 },
          { id: 2, x: 240, y: 230 },
        ],
        at: 90,
      },
    ]);
    expect(r.state.phase).toBe("pinch");
    expect(r.of("zoom")).toHaveLength(1);
    // The scroll it interrupted is closed out rather than left hanging.
    expect(r.of("scrollEnd")).toHaveLength(1);
  });

  it("reports a scale relative to where the fingers started", () => {
    const r = run([
      {
        kind: "start",
        touches: [
          { id: 1, x: 100, y: 200 },
          { id: 2, x: 200, y: 200 },
        ],
        at: 0,
        config: CONFIG,
      },
      {
        kind: "move",
        touches: [
          { id: 1, x: 100, y: 200 },
          { id: 2, x: 300, y: 200 },
        ],
        at: 40,
      },
    ]);
    const zoom = r.of("zoom")[0];
    expect(zoom?.type === "zoom" && zoom.scale).toBeCloseTo(2, 5);
  });

  it("ignores two fingers resting without moving", () => {
    const r = run([
      {
        kind: "start",
        touches: [
          { id: 1, x: 100, y: 200 },
          { id: 2, x: 200, y: 200 },
        ],
        at: 0,
        config: CONFIG,
      },
      {
        kind: "move",
        touches: [
          { id: 1, x: 100, y: 200 },
          { id: 2, x: 203, y: 200 },
        ],
        at: 40,
      },
    ]);
    expect(r.of("zoom")).toEqual([]);
  });

  it("never switches sessions when one finger is lifted first", () => {
    // The cross-fire: whatever the surviving finger does on its way off the
    // screen, it must not be read as a swipe.
    const r = run([
      {
        kind: "start",
        touches: [
          { id: 1, x: 100, y: 200 },
          { id: 2, x: 200, y: 200 },
        ],
        at: 0,
        config: CONFIG,
      },
      {
        kind: "move",
        touches: [
          { id: 1, x: 60, y: 200 },
          { id: 2, x: 240, y: 200 },
        ],
        at: 40,
      },
      { kind: "end", touches: [{ id: 1, x: 60, y: 200 }], at: 60 },
      { kind: "move", touches: [{ id: 1, x: 400, y: 200 }], at: 100 },
      { kind: "end", touches: [], at: 120 },
    ]);
    expect(r.of("swipeCommit")).toEqual([]);
    expect(r.of("zoomEnd")).toHaveLength(1);
    expect(r.state.phase).toBe("idle");
  });

  it("closes out cleanly when the OS cancels it", () => {
    const r = run([
      {
        kind: "start",
        touches: [
          { id: 1, x: 100, y: 200 },
          { id: 2, x: 200, y: 200 },
        ],
        at: 0,
        config: CONFIG,
      },
      { kind: "cancel", at: 40 },
    ]);
    expect(r.of("zoomEnd")).toHaveLength(1);
    expect(r.state.phase).toBe("idle");
    expect(r.state.pinchBase).toBeNull();
  });
});

describe("horizontal swipe — the one that worked occasionally", () => {
  /**
   * The bug had two halves. The visible one was a selection guard that latched
   * forever after a terminal search; that lives in the surface, and is gone
   * because this machine never asks about selection at all. The other half is
   * here: the decision used to be taken once, at release, from the endpoint
   * alone — a ~26.5° cone with no time or velocity bound.
   */
  it("commits a curving swipe that ends well off the axis", () => {
    // 140 across, 90 down: rejected outright by the old endpoint cone.
    const r = run(drag({ x: 300, y: 200 }, { x: 160, y: 290 }));
    expect(r.of("swipeCommit")).toEqual([
      { type: "swipeCommit", direction: "left" },
    ]);
  });

  it("commits a short flick that was still moving when released", () => {
    const r = run(
      drag({ x: 300, y: 200 }, { x: 220, y: 205 }, { durationMs: 120 }),
    );
    expect(r.of("swipeCommit")).toHaveLength(1);
  });

  it("does not commit a slow 80px drag", () => {
    // No velocity bound at all is what let a resting finger switch sessions.
    const r = run(
      drag({ x: 300, y: 200 }, { x: 220, y: 205 }, { durationMs: 1200 }),
    );
    expect(r.of("swipeCommit")).toEqual([]);
  });

  it("does not commit a long drag that took forever", () => {
    const r = run(
      drag({ x: 400, y: 200 }, { x: 100, y: 205 }, { durationMs: 4000 }),
    );
    expect(r.of("swipeCommit")).toEqual([]);
  });

  it("reports the direction the finger travelled", () => {
    const right = run(drag({ x: 100, y: 200 }, { x: 300, y: 205 }));
    expect(right.of("swipeCommit")).toEqual([
      { type: "swipeCommit", direction: "right" },
    ]);
  });

  it("emits nothing at all while the finger is still down", () => {
    const inputs = drag({ x: 300, y: 200 }, { x: 160, y: 205 });
    const held = run(inputs.slice(0, -1));
    expect(held.of("swipeCommit")).toEqual([]);
    expect(held.state.phase).toBe("swipe");
  });
});

describe("claiming", () => {
  it("claims exactly once, and only after the tap window has closed", () => {
    const r = run(drag({ x: 200, y: 100 }, { x: 200, y: 400 }));
    expect(r.of("claim")).toHaveLength(1);
    // False through `pending`, true from the locking move onward — including
    // the release, so no trailing click reaches tmux.
    expect(r.prevented[0]).toBe(false);
    expect(r.prevented.at(-1)).toBe(true);
  });

  it("never claims a tap, so a selection survives one", () => {
    const r = run([down(100, 100, 0), up(40)]);
    expect(r.of("claim")).toEqual([]);
  });
});

describe("widgets that own their own touches", () => {
  it("absorbs a gesture that started on one", () => {
    const r = run([
      {
        kind: "start",
        touches: [{ id: 1, x: 100, y: 100 }],
        at: 0,
        passthrough: true,
        config: CONFIG,
      },
      move(400, 100, 60),
      up(80),
    ]);
    expect(r.effects).toEqual([]);
    expect(r.prevented.every((p) => p === false)).toBe(true);
  });
});

describe("settings", () => {
  it("does nothing on a vertical drag when scrolling is off", () => {
    const off = { ...CONFIG, dragToScroll: false };
    const r = run([
      {
        kind: "start",
        touches: [{ id: 1, x: 200, y: 100 }],
        at: 0,
        config: off,
      },
      move(200, 300, 60),
      up(80),
    ]);
    expect(r.effects).toEqual([]);
  });

  it("does not fall back to scrolling when swiping is off", () => {
    const off = { ...CONFIG, swipeToSwitch: false };
    const r = run([
      {
        kind: "start",
        touches: [{ id: 1, x: 300, y: 200 }],
        at: 0,
        config: off,
      },
      move(100, 205, 60),
      up(80),
    ]);
    expect(r.effects).toEqual([]);
  });

  it("latches the config for the whole gesture", () => {
    // Turning pinch off mid-drag must not leave a pinch running from a null
    // baseline, which is what the old handler's per-event re-read allowed.
    const r = run([
      {
        kind: "start",
        touches: [
          { id: 1, x: 100, y: 200 },
          { id: 2, x: 200, y: 200 },
        ],
        at: 0,
        config: CONFIG,
      },
      {
        kind: "move",
        touches: [
          { id: 1, x: 50, y: 200 },
          { id: 2, x: 250, y: 200 },
        ],
        at: 40,
      },
    ]);
    expect(r.state.config).toEqual(CONFIG);
    expect(r.of("zoom")).toHaveLength(1);
  });
});

/*
 * Everything below came out of an adversarial pass over the machine after the
 * three original bugs were fixed. They share one root: `TouchEvent.touches` is
 * document-wide, so a finger resting anywhere on the page — the window tabs,
 * the FAB — arrives here as a second touch. The surface now filters by element,
 * but the machine must not depend on that being perfect.
 */
/**
 * The bug: a released drag stopped dead, so covering a long history meant a
 * dozen full-screen drags. Every other scrolling surface on a phone coasts.
 */
describe("fling on release", () => {
  it("coasts after a fast drag, in the direction it was going", () => {
    // 300px in 100ms is 3px/ms, comfortably above the gate.
    const r = run(
      drag(
        { x: 200, y: 100 },
        { x: 200, y: 400 },
        {
          steps: 10,
          durationMs: 100,
        },
      ),
    );
    const fling = r.of("fling");
    expect(fling).toHaveLength(1);
    // Downward is backward in time, the same sign `scroll` uses.
    expect((fling[0] as { velocity: number }).velocity).toBeGreaterThan(0);
    // The flush still happens; a fling is in addition to it, never instead.
    expect(r.of("scrollEnd")).toHaveLength(1);
  });

  it("keeps its sign when the drag went the other way", () => {
    const r = run(
      drag(
        { x: 200, y: 400 },
        { x: 200, y: 100 },
        {
          steps: 10,
          durationMs: 100,
        },
      ),
    );
    const fling = r.of("fling");
    expect(fling).toHaveLength(1);
    expect((fling[0] as { velocity: number }).velocity).toBeLessThan(0);
  });

  it("does not fling a finger that was being placed, not thrown", () => {
    // The same 300px, over three seconds: 0.1px/ms, under the gate.
    const r = run(
      drag(
        { x: 200, y: 100 },
        { x: 200, y: 400 },
        {
          steps: 30,
          durationMs: 3000,
        },
      ),
    );
    expect(r.of("fling")).toHaveLength(0);
    expect(r.of("scrollEnd")).toHaveLength(1);
  });

  it("measures the release from changedTouches when the browser gives it", () => {
    // A flick whose last move sample is stale: the lift is 80px further on,
    // which is the whole reason `changed` is threaded through.
    const r = run([
      down(200, 100, 0),
      move(200, 140, 20),
      move(200, 200, 40),
      lift(60, { changed: [{ id: 1, x: 200, y: 280 }] }),
    ]);
    expect(r.of("fling")).toHaveLength(1);
  });
});

describe("fingers that belong to something else", () => {
  const other: GestureTouch = { id: 9, x: 900, y: 900 };

  it("keeps scrolling when a foreign finger lifts mid-drag", () => {
    // The old code ended the scroll on any touchend and dropped straight to
    // `idle`, where every later move was discarded — so the drag could not even
    // restart until the user lifted and touched again.
    const started = run([down(100, 100), move(100, 160, 50)]);
    expect(started.state.phase).toBe("scroll");

    const after = run(
      [
        lift(60, { still: [{ id: 1, x: 100, y: 160 }], changed: [other] }),
        move(100, 220, 100),
      ],
      started.state,
    );
    expect(after.state.phase).toBe("scroll");
    expect(after.of("scrollEnd")).toHaveLength(0);
    expect(after.of("scroll").length).toBeGreaterThan(0);
  });

  it("never reads a swipe's release position off a different finger", () => {
    // Finger 1 swipes LEFT while finger 2 sits at x=900. The old fallback
    // handed back finger 2 on release and measured its x against finger 1's
    // origin: a 50px swipe left committed 600px to the right.
    const swipe = run([
      down(300, 100),
      move(250, 105, 40),
      move(180, 108, 80),
      lift(100, { still: [other], changed: [{ id: 1, x: 180, y: 108 }] }),
    ]);
    const commits = swipe.of("swipeCommit");
    expect(commits).toHaveLength(1);
    expect(commits[0]).toEqual({ type: "swipeCommit", direction: "left" });
  });

  it("does not turn 2px of drift into a swipe after the primary lifts", () => {
    // Finger 1 at x=300 lifts; finger 2 is still down at x=100. Keeping finger
    // 1's origin made finger 2's first 2px read as a 198px swipe.
    const after = run([
      down(300, 100),
      lift(20, {
        still: [{ id: 2, x: 100, y: 100 }],
        changed: [{ id: 1, x: 300, y: 100 }],
      }),
      { kind: "move", touches: [{ id: 2, x: 102, y: 100 }], at: 40 },
    ]);
    expect(after.of("swipeCommit")).toHaveLength(0);
    expect(after.of("claim")).toHaveLength(0);
    expect(after.state.phase).toBe("pending");
  });

  it("re-anchors to the surviving finger rather than abandoning the gesture", () => {
    const after = run([
      down(300, 100),
      lift(20, {
        still: [{ id: 2, x: 100, y: 100 }],
        changed: [{ id: 1, x: 300, y: 100 }],
      }),
    ]);
    expect(after.state.primaryId).toBe(2);
    expect(after.state.originX).toBe(100);
  });
});

describe("a second finger arriving on a gesture already under way", () => {
  it("closes out the scroll exactly once when it becomes a pinch", () => {
    // Handing `enterPinch` a freshly-reset state made its `phase === "scroll"`
    // test read `pending`, so no `scrollEnd` was emitted and `claim` fired
    // twice for one gesture.
    const scrolling = run([down(100, 100), move(100, 160, 50)]);
    const pinched = run(
      [
        {
          kind: "start",
          touches: [
            { id: 1, x: 100, y: 160 },
            { id: 2, x: 200, y: 160 },
          ],
          at: 60,
          config: CONFIG,
        },
      ],
      scrolling.state,
    );
    expect(pinched.state.phase).toBe("pinch");
    expect(pinched.of("scrollEnd")).toHaveLength(1);
    expect(pinched.of("claim")).toHaveLength(0);
  });

  it("does not unlock a scroll when pinch-to-zoom is switched off", () => {
    const config: GestureConfig = { ...CONFIG, pinchToZoom: false };
    const scrolling = run([
      { kind: "start", touches: [{ id: 1, x: 100, y: 100 }], at: 0, config },
      move(100, 160, 50),
    ]);
    const after = run(
      [
        {
          kind: "start",
          touches: [
            { id: 1, x: 100, y: 160 },
            { id: 2, x: 200, y: 160 },
          ],
          at: 60,
          config,
        },
      ],
      scrolling.state,
    );
    expect(after.state.phase).toBe("scroll");
    expect(after.state.primaryId).toBe(1);
  });
});

describe("a swipe the user changed their mind about", () => {
  it("does not commit when the finger is travelling back at release", () => {
    // 100 → 240 → 170: net +70, and moving fast at the end — but moving LEFT.
    // The unsigned velocity gate read that as a confident rightward flick.
    const swipe = run([
      down(100, 100),
      move(180, 102, 60),
      move(240, 104, 120),
      move(200, 104, 180),
      move(170, 104, 220),
      up(220),
    ]);
    expect(swipe.of("swipeCommit")).toHaveLength(0);
  });

  it("still commits a deliberate long drag that ended slowly", () => {
    const swipe = run([
      down(100, 100),
      move(180, 102, 100),
      move(260, 104, 200),
      move(262, 104, 300),
      up(300),
    ]);
    expect(swipe.of("swipeCommit")).toEqual([
      { type: "swipeCommit", direction: "right" },
    ]);
  });

  it("measures the release from where the finger actually left", () => {
    // A flick that ends between move samples: without `changedTouches` the
    // release is wherever the last touchmove happened to land, which
    // under-reports exactly the short quick swipes the velocity gate accepts.
    const swipe = run([
      down(100, 100),
      move(140, 102, 40),
      lift(80, { changed: [{ id: 1, x: 200, y: 102 }] }),
    ]);
    expect(swipe.of("swipeCommit")).toEqual([
      { type: "swipeCommit", direction: "right" },
    ]);
  });
});

describe("reversing a scroll", () => {
  it("does not spend a line paying off the old direction's remainder", () => {
    // Down 46px is 2.7 cells: 2 lines out, 0.7 owed. Dragging back up 2 cells
    // used to net that 0.7 against the reversal and emit only one line.
    // The first move only locks the axis; scrolling is measured from there.
    const scrolled = run([
      down(100, 100),
      move(100, 120, 30),
      move(100, 166, 50),
    ]);
    expect(scrolled.of("scroll")).toEqual([{ type: "scroll", lines: 2 }]);

    const back = run([move(100, 166 - 2 * CELL, 100)], scrolled.state);
    expect(back.of("scroll")).toEqual([{ type: "scroll", lines: -2 }]);
  });
});
