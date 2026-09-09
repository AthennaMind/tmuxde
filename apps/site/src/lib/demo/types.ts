/**
 * Types for the home-page terminal replay.
 *
 * The player is a pure function of a virtual clock: `frameAt(cast, t)` replays
 * the step list from zero every call and returns what the screen looks like at
 * `t`. Nothing here touches the DOM, which is what makes scrubbing a plain
 * assignment and lets the whole engine be tested headless.
 */

/** Mirrors `TokenKind` in `components/primitives/terminal.tsx`. */
export type TokenKind =
  | "path"
  | "value"
  | "comment"
  | "keyword"
  | "flag"
  | "added"
  | "removed"
  | "done"
  | "blocked"
  | "stalled"
  | "failed"
  | "agent"
  | "qr";

export type Tone = "default" | "muted" | "faint" | "strong";

export interface Span {
  text: string;
  kind?: TokenKind;
  tone?: Tone;
}

export type Row = Span[];

/** Which screen the phone is showing. */
export type PhoneScreen = "pair" | "editor" | "server" | "agent";

export interface PhoneState {
  screen: PhoneScreen;
  /** The screen sliding in during a swipe, or null when settled. */
  incoming: PhoneScreen | null;
  /** -1..1. Negative drags the current screen left (moving forward). */
  swipe: number;
  /** Key of a control being pressed, for the tap flash. */
  tapping: string | null;
  /** Digits entered into the six-box pairing field so far. */
  code: string;
  /** True once the pairing code has been accepted. */
  paired: boolean;
}

export interface Frame {
  /** Always exactly `cast.rows` long. */
  rows: Row[];
  /** Null when the cursor should not be drawn. */
  cursor: { row: number; col: number } | null;
  phone: PhoneState;
  /** Index into `cast.chapters`. */
  chapter: number;
  /** The cast has run past its end. */
  done: boolean;
}

/**
 * One instruction.
 *
 * `mark` is the only zero-duration step; everything else advances the clock,
 * which is what makes `duration` a simple sum and chapter spans contiguous.
 */
export type Step =
  /** Start of a chapter. Zero duration. */
  | { k: "mark"; chapter: string }
  /** Type into the current line, character by character. */
  | { k: "type"; text: string; ms: number }
  /** Commit the current line and emit finished output rows. */
  | { k: "out"; rows: Row[]; ms: number }
  /** Hold. */
  | { k: "wait"; ms: number }
  /** Wipe the viewport. */
  | { k: "clear"; ms: number }
  /** Patch the phone's state. */
  | { k: "phone"; patch: Partial<PhoneState>; ms: number }
  /** Slide `to` in over `ms`, then commit it. */
  | { k: "swipe"; to: PhoneScreen; dir: 1 | -1; ms: number }
  /** Flash a control, then release it. */
  | { k: "tap"; key: string; ms: number };

export interface Cast {
  /** Rows in the laptop viewport. Fixed, so the section never reflows. */
  rows: number;
  /** Columns, for the width fence in the tests. */
  cols: number;
  steps: Step[];
}

export interface ChapterSpan {
  id: string;
  start: number;
  end: number;
}

export interface CompiledCast extends Cast {
  duration: number;
  chapters: ChapterSpan[];
  /** Absolute start time of `steps[i]`. */
  offsets: number[];
}
