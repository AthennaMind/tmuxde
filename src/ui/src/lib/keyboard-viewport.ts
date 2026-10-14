/**
 * Deciding whether the soft keyboard is open, which is harder than it looks.
 *
 * The obvious formula — `innerHeight - visualViewport.height` — is wrong here
 * twice, and both failures are caused by things this app deliberately does:
 *
 * 1. **Android reads ~0.** `app/layout.tsx` sets `interactiveWidget:
 *    "resizes-content"`, which is what makes the terminal usable with the
 *    keyboard up: Chrome shrinks the *layout* viewport too, so the difference
 *    between the two stays near zero however tall the keyboard is. The only
 *    thing that moves is the absolute height, so detection needs a baseline —
 *    the tallest height seen for this orientation with nothing focused and no
 *    zoom — and measures the drop from it.
 *
 * 2. **Pinch-zoom reads as a keyboard.** At `scale: 2` the visual viewport is
 *    half as tall, which is a 400px "keyboard" on a phone. The app ships a
 *    `PinchZoomHandler`, so this is a thing users do on purpose, not a
 *    hypothetical. Any sample away from scale 1 is ignored outright.
 *
 * Pure, and separated from the effect that feeds it, because every one of these
 * cases is a unit test and none of them is reachable in headless Chromium.
 */

export type ViewportSample = {
  /** `window.innerHeight` — the layout viewport. */
  innerHeight: number;
  /** `visualViewport.height`, or innerHeight where there is no visualViewport. */
  visualHeight: number;
  /** `visualViewport.scale`. */
  scale: number;
  /** Whether the page currently has a text-entry element focused. */
  hasFocusedInput: boolean;
  /** Portrait or landscape, so the baseline is not shared across a rotation. */
  orientation: "portrait" | "landscape";
};

export type KeyboardState = {
  open: boolean;
  /** Pixels of viewport the keyboard is occupying, 0 when closed. */
  inset: number;
};

/**
 * Hysteresis, so a viewport that settles near the threshold does not flap.
 *
 * 120 to open clears Android's URL-bar collapse, which is about 90px and is not
 * a keyboard, and sits under the shortest real soft keyboard, which is around
 * 150px. 80 to close means a keyboard shrinking as its suggestion strip goes
 * away does not read as a close.
 */
export const KEYBOARD_OPEN_PX = 120;
export const KEYBOARD_CLOSE_PX = 80;

/** How far `scale` may drift from 1 before a sample is ignored. */
export const SCALE_TOLERANCE = 0.05;

/**
 * The tallest viewport seen per orientation, with nothing focused and no zoom.
 *
 * Kept as state the caller threads through rather than module-level mutable
 * data, so a test can drive a whole session — rotate, focus, zoom, blur —
 * without the previous test's phone leaking into it.
 */
export type KeyboardBaselines = Partial<
  Record<ViewportSample["orientation"], number>
>;

export function computeKeyboardState(
  sample: ViewportSample,
  baselines: KeyboardBaselines,
  previous: KeyboardState = { open: false, inset: 0 },
): { state: KeyboardState; baselines: KeyboardBaselines } {
  // Zoomed. Nothing can be concluded, so hold whatever was already decided
  // rather than flipping the footer away mid-pinch.
  if (Math.abs(sample.scale - 1) > SCALE_TOLERANCE) {
    return { state: previous, baselines };
  }

  const next: KeyboardBaselines = { ...baselines };
  const current = baselines[sample.orientation];

  // A sample with nothing focused cannot have a keyboard in it, so it is the
  // only kind that may *raise* the baseline. Taking the max rather than the
  // latest is what survives Android's URL bar sliding in and out.
  if (!sample.hasFocusedInput) {
    next[sample.orientation] = Math.max(current ?? 0, sample.visualHeight);
    return { state: { open: false, inset: 0 }, baselines: next };
  }

  // Focused, but we have never seen this orientation unfocused — so there is
  // nothing to measure a drop against. Seed it and claim nothing.
  if (current === undefined) {
    /*
     * Rotating while typing lands here, and the naive seed is wrong.
     *
     * The only sample available is one with the keyboard already up, so taking
     * `visualHeight` as the unfocused baseline records a screen that is short
     * by exactly the keyboard. Every later sample then computes a drop of zero
     * and reports the keyboard closed: the nav bar comes back underneath a
     * keyboard that is still there, and the inset collapses. Adding the inset
     * we already believed in reconstructs what the unfocused height must have
     * been, which is the honest estimate and self-corrects the moment the
     * keyboard actually closes.
     */
    next[sample.orientation] = previous.open
      ? sample.visualHeight + previous.inset
      : sample.visualHeight;
    return { state: previous, baselines: next };
  }

  const drop = current - sample.visualHeight;
  const threshold = previous.open ? KEYBOARD_CLOSE_PX : KEYBOARD_OPEN_PX;
  const open = drop >= threshold;
  return {
    state: { open, inset: open ? drop : 0 },
    baselines: next,
  };
}

/** Whether an element is something a soft keyboard would open for. */
export function isTextEntry(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName;
  if (tag === "TEXTAREA") return true;
  if (tag === "INPUT") {
    const type = (el as HTMLInputElement).type;
    // `button`, `checkbox`, `submit` and friends never raise a keyboard.
    return !["button", "checkbox", "radio", "submit", "reset", "file"].includes(
      type,
    );
  }
  return (el as HTMLElement).isContentEditable === true;
}

/** How long a close must persist before it is believed. */
export const KEYBOARD_CLOSE_DEBOUNCE_MS = 150;
