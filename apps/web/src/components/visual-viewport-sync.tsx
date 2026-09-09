"use client";

import { useEffect } from "react";
import {
  KEYBOARD_CLOSE_DEBOUNCE_MS,
  computeKeyboardState,
  isTextEntry,
  type KeyboardBaselines,
  type KeyboardState,
} from "@/lib/keyboard-viewport";

/**
 * Mirrors `window.visualViewport` into CSS custom properties, and publishes
 * whether the soft keyboard is up.
 *
 * The properties let fixed-position chrome pin to the *visual* viewport instead
 * of the layout one — without them, pinch-zoom draws overlays outside the
 * visible area and under the URL bar.
 *
 * `data-keyboard` is the second job, and it is a data attribute rather than
 * React state on purpose: the only consumer is one CSS rule, and re-rendering
 * `TerminalLayoutInner` to hide a nav bar would re-render xterm underneath it.
 * The decision itself lives in `lib/keyboard-viewport.ts`, where it is testable
 * without a phone.
 */
export function VisualViewportSync() {
  useEffect(() => {
    const root = document.documentElement;
    let rafId: number | null = null;
    let baselines: KeyboardBaselines = {};
    let keyboard: KeyboardState = { open: false, inset: 0 };
    let closeTimer: ReturnType<typeof setTimeout> | null = null;

    const applyKeyboard = (next: KeyboardState) => {
      if (next.open === keyboard.open && next.inset === keyboard.inset) return;
      keyboard = next;
      root.dataset.keyboard = next.open ? "open" : "closed";
      root.style.setProperty("--vv-keyboard-inset", `${next.inset}px`);
    };

    /*
     * Orientation, without asking a height the keyboard has already changed.
     *
     * This used to be `innerHeight >= innerWidth`, which is wrong here for a
     * specific reason: the app sets `interactiveWidget: "resizes-content"`, so
     * on Chromium `innerHeight` *shrinks by the keyboard's height*. On a
     * 360×640 phone a ~300px keyboard leaves 340 < 360, so opening the keyboard
     * reclassified the device as landscape — an orientation with no baseline,
     * which the reducer then seeded with the keyboard-shrunk height and
     * reported as closed. `data-keyboard` never became "open" on a small
     * Android phone at all.
     *
     * `screen.orientation` describes the device and is unmoved by any of this;
     * comparing against `screen.width` is the fallback for Safari versions
     * without it, and the screen's own dimensions are likewise unaffected.
     */
    const readOrientation = (): "portrait" | "landscape" => {
      const type = window.screen?.orientation?.type;
      if (typeof type === "string") {
        return type.startsWith("portrait") ? "portrait" : "landscape";
      }
      const { width = 0, height = 0 } = window.screen ?? {};
      return height >= width ? "portrait" : "landscape";
    };

    const update = () => {
      rafId = null;
      const vv = window.visualViewport;
      const width = vv?.width ?? window.innerWidth;
      const height = vv?.height ?? window.innerHeight;
      const offsetTop = vv?.offsetTop ?? 0;
      const offsetLeft = vv?.offsetLeft ?? 0;
      const scale = vv?.scale ?? 1;

      root.style.setProperty("--vv-width", `${width}px`);
      root.style.setProperty("--vv-height", `${height}px`);
      root.style.setProperty("--vv-offset-top", `${offsetTop}px`);
      root.style.setProperty("--vv-offset-left", `${offsetLeft}px`);
      root.style.setProperty("--vv-scale", `${scale}`);

      const result = computeKeyboardState(
        {
          innerHeight: window.innerHeight,
          visualHeight: height,
          scale,
          hasFocusedInput: isTextEntry(document.activeElement),
          orientation: readOrientation(),
        },
        baselines,
        keyboard,
      );
      baselines = result.baselines;

      // Opening is applied at once — the keyboard is already covering the
      // footer, and waiting means a visible overlap. Closing is debounced,
      // because iOS reports intermediate heights as the keyboard slides away
      // and each one would flash the nav back in.
      if (closeTimer) {
        clearTimeout(closeTimer);
        closeTimer = null;
      }
      if (result.state.open || !keyboard.open) {
        applyKeyboard(result.state);
      } else {
        closeTimer = setTimeout(
          () => applyKeyboard(result.state),
          KEYBOARD_CLOSE_DEBOUNCE_MS,
        );
      }
    };

    const schedule = () => {
      if (rafId !== null) return;
      rafId = requestAnimationFrame(update);
    };

    update();

    const vv = window.visualViewport;
    vv?.addEventListener("resize", schedule);
    vv?.addEventListener("scroll", schedule);
    window.addEventListener("resize", schedule);
    window.addEventListener("orientationchange", schedule);
    // Focus moving in or out of a field changes the answer without necessarily
    // resizing anything — a tap from one input to another, or a blur that the
    // keyboard outlives by a frame.
    document.addEventListener("focusin", schedule);
    document.addEventListener("focusout", schedule);

    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      if (closeTimer) clearTimeout(closeTimer);
      vv?.removeEventListener("resize", schedule);
      vv?.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("orientationchange", schedule);
      document.removeEventListener("focusin", schedule);
      document.removeEventListener("focusout", schedule);
    };
  }, []);

  return null;
}
