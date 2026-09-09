import type {
  Cast,
  ChapterSpan,
  CompiledCast,
  Frame,
  PhoneScreen,
  PhoneState,
  Row,
  Span,
  Step,
} from "./types";

/**
 * The replay engine.
 *
 * `frameAt` replays the step list from zero on every call rather than stepping
 * an accumulator forward. That is deliberate: it makes the function pure, so
 * scrubbing backwards costs the same as playing forwards, a reduced-motion
 * render is just `frameAt` at a settled time, and the server can render the
 * poster frame with no clock at all. A cast is ~50 steps, so "replay from
 * zero" is a few microseconds.
 */

const IDLE_PHONE: PhoneState = {
  screen: "pair",
  incoming: null,
  swipe: 0,
  tapping: null,
  code: "",
  paired: false,
};

/** Duration of a step. `mark` is the only zero-length one. */
function stepMs(step: Step): number {
  return step.k === "mark" ? 0 : step.ms;
}

export function compileCast(cast: Cast): CompiledCast {
  const offsets: number[] = [];
  const chapters: ChapterSpan[] = [];
  let t = 0;

  for (const step of cast.steps) {
    offsets.push(t);
    if (step.k === "mark") {
      // Close the previous chapter exactly where this one opens, so the spans
      // tile `[0, duration]` with no gap for a scrubber to fall into.
      const previous = chapters.at(-1);
      if (previous) previous.end = t;
      chapters.push({ id: step.chapter, start: t, end: t });
    }
    t += stepMs(step);
  }

  const last = chapters.at(-1);
  if (last) last.end = t;

  return { ...cast, offsets, duration: t, chapters };
}

/** Index of the chapter containing `t`, clamped to the ends. */
export function chapterAt(cast: CompiledCast, t: number): number {
  if (cast.chapters.length === 0) return 0;
  if (t < 0) return 0;
  for (let i = cast.chapters.length - 1; i >= 0; i--) {
    if (t >= cast.chapters[i]!.start) return i;
  }
  return 0;
}

/**
 * A time at which chapter `index` is fully settled: everything typed, nothing
 * mid-swipe.
 *
 * This is what a reduced-motion visitor and the SSR poster frame render, so it
 * has to land on the *last* moment of the chapter rather than anywhere inside
 * it.
 */
export function settledTimeAt(cast: CompiledCast, index: number): number {
  const chapter = cast.chapters[index];
  if (!chapter) return cast.duration;
  // One millisecond short of the boundary: at `end` exactly, the next
  // chapter's first step has already begun.
  return Math.max(chapter.start, chapter.end - 1);
}

/** Visible width of a row, for the layout fence. */
export function rowWidth(row: Row): number {
  return row.reduce((n, span) => n + span.text.length, 0);
}

function cloneRow(row: Row): Row {
  return row.map((span) => ({ ...span }));
}

/**
 * The frame at `t`.
 *
 * Returned rows are always freshly built, never aliases of the cast's own
 * arrays — a consumer that mutated one would corrupt every later frame.
 */
export function frameAt(cast: CompiledCast, t: number): Frame {
  const clock = Math.max(0, Math.min(t, cast.duration));
  const committed: Row[] = [];
  let current: Row | null = null;
  const phone: PhoneState = { ...IDLE_PHONE };
  let chapter = 0;
  let seenChapters = -1;

  for (let i = 0; i < cast.steps.length; i++) {
    const step = cast.steps[i]!;
    const start = cast.offsets[i]!;
    const length = stepMs(step);
    const elapsed = clock - start;
    // `progress` is 1 for a step already finished, 0..1 for the one in flight.
    const done = elapsed >= length;
    const progress = length === 0 ? 1 : Math.max(0, Math.min(1, elapsed / length));

    if (elapsed < 0) break;

    switch (step.k) {
      case "mark":
        seenChapters++;
        chapter = seenChapters;
        break;

      case "type": {
        const shown = Math.floor(step.text.length * progress);
        const text = step.text.slice(0, done ? step.text.length : shown);
        current = [{ text }];
        break;
      }

      case "out": {
        // Output arrives as a block once the step's time has been spent, so a
        // half-elapsed `out` shows the prompt line it follows and nothing more.
        if (current) {
          committed.push(current);
          current = null;
        }
        if (!done) break;
        for (const row of step.rows) committed.push(cloneRow(row));
        break;
      }

      case "clear":
        if (done) {
          committed.length = 0;
          current = null;
        }
        break;

      case "phone":
        if (done) Object.assign(phone, step.patch);
        break;

      case "swipe":
        if (done) {
          phone.screen = step.to;
          phone.incoming = null;
          phone.swipe = 0;
        } else {
          phone.incoming = step.to;
          phone.swipe = -step.dir * progress;
        }
        break;

      case "tap":
        // Held for the first half of the step, released for the second, so a
        // settled frame never shows a stuck press.
        phone.tapping = done || progress > 0.5 ? null : step.key;
        break;

      case "wait":
        break;
    }
  }

  // Pad or scroll to exactly `cast.rows`. Doing it here rather than in CSS is
  // what guarantees the section's height never changes mid-play.
  const live = current ? [...committed, current] : committed;
  const visible =
    live.length > cast.rows ? live.slice(live.length - cast.rows) : live;
  const rows: Row[] = visible.map(cloneRow);
  while (rows.length < cast.rows) rows.push([]);

  const cursorRow = visible.length === 0 ? 0 : visible.length - 1;
  const cursor = {
    row: Math.min(cursorRow, cast.rows - 1),
    col: rowWidth(rows[Math.min(cursorRow, cast.rows - 1)] ?? []),
  };

  return {
    rows,
    cursor,
    phone,
    chapter: Math.max(0, chapter),
    done: t >= cast.duration,
  };
}

/** Convenience for the poster frame and the reduced-motion render. */
export function settledFrame(cast: CompiledCast, index: number): Frame {
  return frameAt(cast, settledTimeAt(cast, index));
}

export type { Cast, CompiledCast, Frame, PhoneScreen, PhoneState, Row, Span };
