import type { Page, Locator } from "@playwright/test";

/**
 * Synthetic multi-touch, driven from a spec.
 *
 * ## Why not `page.touchscreen`
 *
 * Playwright's touchscreen can tap. It cannot drag two fingers apart, and the
 * CDP route that could (`Input.dispatchTouchEvent`) is Chromium-only — which
 * would mean no gesture coverage on WebKit, the one engine that resembles the
 * platform this app's hardest workarounds exist for.
 *
 * ## Why this is a fair test and not a fake one
 *
 * `terminal-gesture-surface.tsx` reads exactly five things off a touch event:
 * `touches`, `changedTouches`, `timeStamp`, `target` and `cancelable`. It hands
 * them to `reduceGesture`, which is DOM-free by construction. So an event
 * carrying those five things exercises the real recognizer, the real listener
 * wiring (capture, non-passive), the real `preventDefault` decision and the
 * real effects — everything except the browser's own hit testing.
 *
 * The events are built with `new Event(...)` and the touch lists defined onto
 * them, rather than with `new TouchEvent(...)`. `TouchEvent` and its `Touch`
 * constructor are not available on every engine Playwright ships, and the one
 * place they are missing is the one place this coverage matters most.
 *
 * What this cannot prove stays in `e2e/MANUAL.md`: whether the *UA* would have
 * scrolled or zoomed first. `touch-action: none` on the surface is what denies
 * it that, and `gestures.ts` asserts the declaration is still there.
 */

export type Point = { x: number; y: number };

/** A single finger's path. `id` distinguishes fingers within one gesture. */
export type Finger = { id: number; points: Point[] };

/**
 * Play a multi-finger gesture into an element.
 *
 * Every finger's path must have the same number of samples; frame `i` of the
 * gesture is sample `i` of each. `stepMs` is written into `timeStamp`, which is
 * what the recognizer's velocity gates read — so a flick and a slow drag differ
 * here by exactly the number the app uses to tell them apart.
 */
export async function playGesture(
  target: Locator,
  fingers: Finger[],
  opts: { stepMs?: number; endWithCancel?: boolean } = {},
): Promise<void> {
  const stepMs = opts.stepMs ?? 16;
  await target.evaluate(
    (el, { fingers, stepMs, endWithCancel }) => {
      const rect = el.getBoundingClientRect();

      type P = { x: number; y: number };
      const mk = (id: number, p: P) => ({
        identifier: id,
        clientX: rect.left + p.x,
        clientY: rect.top + p.y,
        pageX: rect.left + p.x,
        pageY: rect.top + p.y,
        screenX: rect.left + p.x,
        screenY: rect.top + p.y,
        radiusX: 8,
        radiusY: 8,
        rotationAngle: 0,
        force: 1,
        target: el,
      });

      const fire = (
        type: string,
        touches: unknown[],
        changed: unknown[],
        at: number,
      ) => {
        const ev = new Event(type, { bubbles: true, cancelable: true });
        for (const [key, value] of [
          ["touches", touches],
          ["targetTouches", touches],
          ["changedTouches", changed],
          ["timeStamp", at],
        ] as const) {
          Object.defineProperty(ev, key, { value, configurable: true });
        }
        el.dispatchEvent(ev);
      };

      const frames = fingers[0]?.points.length ?? 0;
      // `performance.now()` as the base, because the recognizer compares
      // timestamps to each other and to its own budgets; an absolute epoch
      // would blow past SWIPE_MAX_MS on the first frame.
      const t0 = performance.now();
      const at = (frame: number) => t0 + frame * stepMs;

      // Fingers land one frame apart, which is what actually happens and is
      // also the exact shape of the pinch bug this app already fixed once: a
      // handler that ignored `touchstart` unless two fingers were already down
      // never claimed the first one.
      const down: unknown[] = [];
      for (const f of fingers) {
        const t = mk(f.id, f.points[0]!);
        down.push(t);
        fire("touchstart", [...down], [t], t0);
      }

      for (let i = 1; i < frames; i++) {
        const moving = fingers.map((f) => mk(f.id, f.points[i]!));
        fire("touchmove", moving, moving, at(i));
      }

      if (endWithCancel) {
        fire("touchcancel", [], [], at(frames));
        return;
      }

      // Lift in reverse order, each `touches` carrying the fingers still down.
      const last = fingers.map((f) => mk(f.id, f.points[frames - 1]!));
      for (let i = fingers.length - 1; i >= 0; i--) {
        fire("touchend", last.slice(0, i), [last[i]!], at(frames));
      }
    },
    { fingers, stepMs, endWithCancel: opts.endWithCancel ?? false },
  );
}

/** Linear interpolation between two points, `steps` samples inclusive of both. */
export function path(from: Point, to: Point, steps = 10): Point[] {
  return Array.from({ length: steps }, (_, i) => {
    const t = i / (steps - 1);
    return { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t };
  });
}

/**
 * A one-finger horizontal swipe.
 *
 * `stepMs: 8` by default so the release velocity clears `SWIPE_MIN_VELOCITY`
 * (0.3 px/ms). A swipe of the same distance played slowly is a *different*
 * gesture as far as the app is concerned, and `gestures.ts` asserts both.
 */
export function swipe(
  from: Point,
  dx: number,
  opts: { steps?: number } = {},
): Finger[] {
  return [
    {
      id: 1,
      points: path(from, { x: from.x + dx, y: from.y }, opts.steps ?? 10),
    },
  ];
}

/** A one-finger vertical drag. Positive `dy` is downward, i.e. into history. */
export function drag(from: Point, dy: number, steps = 12): Finger[] {
  return [{ id: 1, points: path(from, { x: from.x, y: from.y + dy }, steps) }];
}

/**
 * A two-finger pinch around `centre`.
 *
 * `scale > 1` spreads (zoom in), `< 1` closes. The fingers start `base` apart
 * and end `base * scale` apart, both on the horizontal axis — the recognizer
 * measures separation, not orientation.
 */
export function pinch(
  centre: Point,
  scale: number,
  opts: { base?: number; steps?: number } = {},
): Finger[] {
  const base = opts.base ?? 120;
  const steps = opts.steps ?? 12;
  const half = base / 2;
  const endHalf = (base * scale) / 2;
  return [
    {
      id: 1,
      points: path(
        { x: centre.x - half, y: centre.y },
        { x: centre.x - endHalf, y: centre.y },
        steps,
      ),
    },
    {
      id: 2,
      points: path(
        { x: centre.x + half, y: centre.y },
        { x: centre.x + endHalf, y: centre.y },
        steps,
      ),
    },
  ];
}

/** The centre of a locator's box, in element-local coordinates. */
export async function centreOf(locator: Locator): Promise<Point> {
  const box = await locator.boundingBox();
  if (!box) throw new Error("cannot centre on an element that is not laid out");
  return { x: box.width / 2, y: box.height / 2 };
}

/** A plain tap, for the cases where the gesture under test is "not a gesture". */
export async function tap(target: Locator, at?: Point): Promise<void> {
  const box = await target.boundingBox();
  if (!box) throw new Error("cannot tap an element that is not laid out");
  const p = at ?? { x: box.width / 2, y: box.height / 2 };
  await playGesture(target, [{ id: 1, points: [p, p] }], { stepMs: 40 });
}

/**
 * Shrink `visualViewport` the way a soft keyboard does, and tell the page.
 *
 * Playwright cannot raise a real keyboard, and `keyboard-viewport.ts` is driven
 * entirely by `visualViewport` — height, offsetTop and scale — so this is the
 * input the app actually consumes. The scale is left at 1 deliberately: a
 * keyboard does not change it, and a pinch-zoom does, which is how the app
 * tells them apart. Passing a scale here is how `gestures.ts` proves the
 * pinch-is-not-a-keyboard rule still holds.
 */
export async function setVisualViewport(
  page: Page,
  next: { height?: number; offsetTop?: number; scale?: number },
): Promise<void> {
  await page.evaluate((n) => {
    const vv = window.visualViewport;
    if (!vv) throw new Error("visualViewport is not available in this context");
    const patch = <K extends keyof VisualViewport>(key: K, value: unknown) => {
      if (value === undefined) return;
      Object.defineProperty(vv, key, { value, configurable: true });
    };
    patch("height", n.height);
    patch("offsetTop", n.offsetTop);
    patch("scale", n.scale);
    vv.dispatchEvent(new Event("resize"));
    vv.dispatchEvent(new Event("scroll"));
  }, next);
}
