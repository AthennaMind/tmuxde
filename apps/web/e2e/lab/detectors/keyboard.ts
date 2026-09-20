import { setVisualViewport } from "../touch";
import { findingId, type Detector, type Finding } from "./types";

/**
 * The soft keyboard, and the contract the app publishes about it.
 *
 * Playwright cannot raise a real keyboard. It does not have to:
 * `lib/keyboard-viewport.ts` is driven entirely by `visualViewport` — height,
 * `offsetTop` and `scale` — so shrinking that is the same input the app
 * consumes on a real device. What cannot be reproduced is iOS's own scrolling
 * of the page when a field focuses, and that stays in `e2e/MANUAL.md`.
 *
 * ## What is asserted, and why each of these and not others
 *
 * Every item here is a regression that actually shipped, named in
 * `e2e/MANUAL.md` or in the source it guards:
 *
 *  - the CSS custom properties exist at all, because fixed chrome pins to them
 *    and a missing one silently falls back to the layout viewport;
 *  - `data-keyboard="open"`, because one CSS rule is its only consumer and that
 *    rule is what hides the bottom nav;
 *  - the nav is actually hidden, because "the attribute is set" and "the nav
 *    moved" are different claims and only the second one is the feature;
 *  - nothing interactive sits under the keyboard, which is the composer and
 *    footer bug from `app-shell.tsx`;
 *  - and a pinch (scale > 1) must **not** look like a keyboard, which is the
 *    `keyboard-viewport.ts:1` regression and the reason the scale tolerance
 *    exists.
 */
export const keyboard: Detector = async ({ page, stop, device }) => {
  const isTouch = await page.evaluate(
    () => matchMedia("(pointer: coarse)").matches,
  );
  if (!isTouch) return [];

  const findings: Finding[] = [];
  const add = (
    id: string,
    detail: string,
    severity: Finding["severity"] = "major",
    measured?: Finding["measured"],
  ) =>
    findings.push({
      id: findingId("keyboard", id, device),
      severity,
      detector: "keyboard",
      detail,
      where: `${stop.session}/${stop.state}`,
      measured,
    });

  const baseline = await page.evaluate(() => ({
    innerHeight: window.innerHeight,
    visualHeight: window.visualViewport?.height ?? window.innerHeight,
  }));

  // 300px is a realistic phone keyboard and is comfortably past
  // KEYBOARD_OPEN_PX (120), so this tests the app's reaction rather than its
  // threshold. The threshold itself is a unit test's job.
  const KEYBOARD_PX = 300;

  // A focused text entry is part of the signal `computeKeyboardState` reads —
  // a viewport that shrinks with nothing focused is a URL bar collapsing, not
  // a keyboard, which is its own listed regression.
  await page.evaluate(() => {
    const field = document.querySelector<HTMLElement>(
      "textarea.xterm-helper-textarea, input, textarea",
    );
    field?.focus();
  });

  await setVisualViewport(page, {
    height: baseline.visualHeight - KEYBOARD_PX,
    offsetTop: 0,
    scale: 1,
  });
  await page.waitForTimeout(250);

  const open = await page.evaluate(() => {
    const root = document.documentElement;
    const style = getComputedStyle(root);
    const read = (name: string) => style.getPropertyValue(name).trim();
    const vvHeight = window.visualViewport?.height ?? window.innerHeight;

    const nav = document.querySelector(".mtmux-hide-when-keyboard");
    const navBox = nav?.getBoundingClientRect() ?? null;
    const navHidden =
      !nav ||
      !navBox ||
      navBox.height === 0 ||
      getComputedStyle(nav).display === "none" ||
      navBox.top >= vvHeight;

    // Anything the user is expected to operate while typing must be above the
    // keyboard line. Measured against the *visual* viewport, which is what the
    // keyboard shrank.
    const occluded: string[] = [];
    for (const el of Array.from(
      document.querySelectorAll<HTMLElement>(
        "button, [role=button], input, textarea, [role=tab]",
      ),
    )) {
      const style = getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") continue;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      // Only report things that were on screen *before* the keyboard; a control
      // already scrolled out of view is not occluded by anything.
      if (rect.top > window.innerHeight) continue;
      if (rect.top >= vvHeight) {
        const label =
          el.getAttribute("aria-label") ??
          (el.textContent ?? "").trim().slice(0, 32) ??
          el.tagName;
        occluded.push(`${el.tagName.toLowerCase()} "${label}"`);
      }
    }

    return {
      dataKeyboard: root.dataset.keyboard ?? "",
      vars: {
        height: read("--vv-height"),
        inset: read("--vv-keyboard-inset"),
        offsetTop: read("--vv-offset-top"),
        width: read("--vv-width"),
        scale: read("--vv-scale"),
      },
      navPresent: !!nav,
      navHidden,
      occluded: occluded.slice(0, 8),
      vvHeight,
    };
  });

  for (const [name, value] of Object.entries(open.vars)) {
    if (value === "") {
      add(
        `missing-var-${name}`,
        `--vv-${name} is not set on <html>; fixed chrome pinned to it falls ` +
          "back to the layout viewport, which the keyboard does not shrink",
        "major",
      );
    }
  }

  if (open.dataKeyboard !== "open") {
    add(
      "not-open",
      `the visual viewport shrank by ${KEYBOARD_PX}px with a text field ` +
        `focused and data-keyboard is "${open.dataKeyboard || "unset"}"`,
      "blocker",
      { shrankBy: KEYBOARD_PX, dataKeyboard: open.dataKeyboard },
    );
  } else if (open.navPresent && !open.navHidden) {
    add(
      "nav-not-hidden",
      "data-keyboard is open but .mtmux-hide-when-keyboard is still laid out — " +
        "the attribute is set and the CSS rule that consumes it is not working",
      "major",
    );
  }

  for (const label of open.occluded) {
    add(
      `occluded-${label}`,
      `${label} sits below the keyboard line (${Math.round(open.vvHeight)}px) ` +
        "and cannot be reached while typing",
      "major",
    );
  }

  /*
   * A pinch is not a keyboard.
   *
   * Same shrunken height, but `scale` above 1 — which is exactly what
   * pinch-zoom produces and what `SCALE_TOLERANCE` exists to reject. The
   * regression this guards hid the bottom nav whenever anyone zoomed in.
   */
  await setVisualViewport(page, {
    height: baseline.visualHeight - KEYBOARD_PX,
    scale: 1.8,
  });
  await page.waitForTimeout(250);
  const zoomed = await page.evaluate(
    () => document.documentElement.dataset.keyboard ?? "",
  );
  if (zoomed === "open") {
    add(
      "pinch-read-as-keyboard",
      "a visual viewport shrunk with scale 1.8 — a pinch-zoom — was reported " +
        "as an open keyboard, so zooming in hides the bottom nav",
      "major",
      { scale: 1.8 },
    );
  }

  // Put it back, so the next detector at this stop sees an unzoomed page.
  await setVisualViewport(page, {
    height: baseline.visualHeight,
    offsetTop: 0,
    scale: 1,
  });
  await page.waitForTimeout(250);

  return findings;
};
