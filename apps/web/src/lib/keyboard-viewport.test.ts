import { describe, it, expect } from "vitest";
import {
  KEYBOARD_CLOSE_PX,
  KEYBOARD_OPEN_PX,
  computeKeyboardState,
  isTextEntry,
  type KeyboardBaselines,
  type KeyboardState,
  type ViewportSample,
} from "./keyboard-viewport";

const sample = (over: Partial<ViewportSample> = {}): ViewportSample => ({
  innerHeight: 800,
  visualHeight: 800,
  scale: 1,
  hasFocusedInput: false,
  orientation: "portrait",
  ...over,
});

/** Drive a sequence of samples through the reducer, keeping state. */
function play(samples: ViewportSample[]) {
  let baselines: KeyboardBaselines = {};
  let state = { open: false, inset: 0 };
  const seen: (typeof state)[] = [];
  for (const s of samples) {
    const result = computeKeyboardState(s, baselines, state);
    baselines = result.baselines;
    state = result.state;
    seen.push(state);
  }
  return { state, baselines, seen };
}

describe("Android with resizes-content", () => {
  it("detects a keyboard the naive formula cannot see", () => {
    // `interactiveWidget: "resizes-content"` shrinks the *layout* viewport too,
    // so `innerHeight - visualHeight` stays ~0 however tall the keyboard is.
    // Only the absolute height moves, which is why a baseline exists at all.
    const { state } = play([
      sample({ innerHeight: 800, visualHeight: 800 }),
      sample({ innerHeight: 480, visualHeight: 480, hasFocusedInput: true }),
    ]);
    expect(800 - 800).toBe(0); // what the naive formula would have measured
    expect(state.open).toBe(true);
    expect(state.inset).toBe(320);
  });

  it("is not fooled by the URL bar collapsing", () => {
    // ~90px, and not a keyboard. The 120px threshold exists for exactly this.
    const { state } = play([
      sample({ visualHeight: 800 }),
      sample({ visualHeight: 710, hasFocusedInput: true }),
    ]);
    expect(state.open).toBe(false);
  });
});

describe("iOS", () => {
  it("detects the usual overlay keyboard", () => {
    const { state } = play([
      sample({ innerHeight: 844, visualHeight: 844 }),
      sample({ innerHeight: 844, visualHeight: 508, hasFocusedInput: true }),
    ]);
    expect(state.open).toBe(true);
    expect(state.inset).toBe(336);
  });
});

describe("pinch zoom", () => {
  it("does not read a zoom as a 400px keyboard", () => {
    // The app ships a PinchZoomHandler, so this is something users do on
    // purpose. At scale 2 the visual viewport is half as tall.
    const { state } = play([
      sample({ visualHeight: 800 }),
      sample({ visualHeight: 400, scale: 2, hasFocusedInput: true }),
    ]);
    expect(state.open).toBe(false);
  });

  it("holds the previous answer rather than flipping mid-pinch", () => {
    const { state } = play([
      sample({ visualHeight: 800 }),
      sample({ visualHeight: 480, hasFocusedInput: true }),
      sample({ visualHeight: 240, scale: 2, hasFocusedInput: true }),
    ]);
    expect(state.open).toBe(true);
  });

  it("ignores a zoomed sample for the baseline too", () => {
    const { baselines } = play([sample({ visualHeight: 1600, scale: 0.5 })]);
    expect(baselines.portrait).toBeUndefined();
  });
});

describe("hysteresis", () => {
  it("needs more to open than to stay open", () => {
    const { seen } = play([
      sample({ visualHeight: 800 }),
      // 100px: over the close threshold, under the open one.
      sample({ visualHeight: 700, hasFocusedInput: true }),
      // 300px: open.
      sample({ visualHeight: 500, hasFocusedInput: true }),
      // Back to 100px: still open, because closing needs to drop under 80.
      sample({ visualHeight: 700, hasFocusedInput: true }),
      // 60px: closed.
      sample({ visualHeight: 740, hasFocusedInput: true }),
    ]);
    expect(seen.map((s) => s.open)).toEqual([false, false, true, true, false]);
    expect(KEYBOARD_OPEN_PX).toBeGreaterThan(KEYBOARD_CLOSE_PX);
  });
});

describe("baselines", () => {
  it("keeps one per orientation", () => {
    // A rotation changes the height by hundreds of pixels, which would read as
    // a keyboard for the rest of the session against a shared baseline.
    const { state, baselines } = play([
      sample({ visualHeight: 800, orientation: "portrait" }),
      sample({ visualHeight: 380, orientation: "landscape" }),
      sample({
        visualHeight: 380,
        orientation: "landscape",
        hasFocusedInput: true,
      }),
    ]);
    expect(baselines).toEqual({ portrait: 800, landscape: 380 });
    expect(state.open).toBe(false);
  });

  it("only ever grows, so a mid-session URL bar does not lower it", () => {
    const { baselines } = play([
      sample({ visualHeight: 800 }),
      sample({ visualHeight: 710 }),
      sample({ visualHeight: 760 }),
    ]);
    expect(baselines.portrait).toBe(800);
  });

  it("claims nothing on a first sample that is already focused", () => {
    // Nothing to measure a drop against, so seed and say nothing rather than
    // guess — an app opened straight into a focused field is a real case.
    const { state, baselines } = play([
      sample({ visualHeight: 480, hasFocusedInput: true }),
    ]);
    expect(state.open).toBe(false);
    expect(baselines.portrait).toBe(480);
  });

  it("never reports a keyboard while nothing is focused", () => {
    const { state } = play([
      sample({ visualHeight: 800 }),
      sample({ visualHeight: 400 }),
    ]);
    expect(state).toEqual({ open: false, inset: 0 });
  });
});

describe("isTextEntry", () => {
  // Duck-typed rather than real DOM nodes: this suite runs in the node
  // environment on purpose, and the predicate only ever reads three fields.
  const el = (tagName: string, over: Record<string, unknown> = {}) =>
    ({ tagName, ...over }) as unknown as Element;

  it("recognises what raises a soft keyboard", () => {
    expect(isTextEntry(el("TEXTAREA"))).toBe(true);
    expect(isTextEntry(el("INPUT", { type: "text" }))).toBe(true);
    expect(isTextEntry(el("INPUT", { type: "search" }))).toBe(true);
    expect(isTextEntry(el("DIV", { isContentEditable: true }))).toBe(true);
  });

  it("ignores inputs that never raise one", () => {
    for (const type of ["button", "checkbox", "radio", "submit", "file"]) {
      expect(isTextEntry(el("INPUT", { type }))).toBe(false);
    }
    expect(isTextEntry(el("DIV"))).toBe(false);
    expect(isTextEntry(el("BUTTON"))).toBe(false);
    expect(isTextEntry(null)).toBe(false);
  });
});

describe("rotating while typing", () => {
  /*
   * The new orientation has never been seen unfocused, so the only sample
   * available has the keyboard in it. Seeding the baseline with that height
   * made the very next sample compute a drop of zero — the nav bar reappeared
   * underneath a keyboard that was still up, and the inset fell to nothing.
   */
  it("keeps believing in the keyboard across the rotation", () => {
    let baselines: KeyboardBaselines = {};
    let state: KeyboardState = { open: false, inset: 0 };

    // Portrait, unfocused: 800 tall.
    ({ state, baselines } = computeKeyboardState(
      sample({ visualHeight: 800, orientation: "portrait" }),
      baselines,
      state,
    ));
    // Portrait, typing: 500 tall, so a 300px keyboard.
    ({ state, baselines } = computeKeyboardState(
      sample({
        visualHeight: 500,
        orientation: "portrait",
        hasFocusedInput: true,
      }),
      baselines,
      state,
    ));
    expect(state).toEqual({ open: true, inset: 300 });

    // Rotate, still typing. Landscape has no baseline of its own.
    ({ state, baselines } = computeKeyboardState(
      sample({
        visualHeight: 200,
        orientation: "landscape",
        hasFocusedInput: true,
      }),
      baselines,
      state,
    ));
    expect(state.open).toBe(true);
    expect(baselines.landscape).toBe(500);

    // And the next sample in the new orientation still says "open".
    ({ state } = computeKeyboardState(
      sample({
        visualHeight: 200,
        orientation: "landscape",
        hasFocusedInput: true,
      }),
      baselines,
      state,
    ));
    expect(state).toEqual({ open: true, inset: 300 });
  });

  it("self-corrects once the keyboard actually closes", () => {
    let baselines: KeyboardBaselines = { landscape: 500 };
    let state: KeyboardState = { open: true, inset: 300 };
    ({ state, baselines } = computeKeyboardState(
      sample({ visualHeight: 380, orientation: "landscape" }),
      baselines,
      state,
    ));
    expect(state).toEqual({ open: false, inset: 0 });
    expect(baselines.landscape).toBe(500);
  });
});
