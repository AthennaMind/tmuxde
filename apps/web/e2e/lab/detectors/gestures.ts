import { findingId, type Detector, type Finding } from "./types";

/**
 * The gesture surface's static contract.
 *
 * The recognizer itself is a pure reducer with its own unit suite, and its
 * behaviour end to end is asserted in `gestures.spec.ts`. What neither of those
 * covers is the wiring that has to be right for the recognizer to be consulted
 * at all — and every item below is a wiring failure that has already happened
 * once, documented in `lib/touch-gestures.ts`'s own header.
 *
 * ## `touch-action`
 *
 * The single most important declaration in the mobile app. The old surface
 * asked for `pan-y`, which lets the UA commit to a pan before a second finger
 * lands — and on iOS every subsequent `touchmove` is then non-cancelable, so
 * `preventDefault()` does nothing and pinch works or does not depending on
 * which finger drifted first. `none` is what makes the recognizer's decision
 * the only decision. An ancestor re-introducing `pan-y` or `manipulation` puts
 * the bug straight back, so ancestors are checked too.
 *
 * ## `overscroll-behavior`
 *
 * A vertical drag in the terminal that reaches the top of the document is a
 * pull-to-refresh on Android Chrome and a rubber-band on iOS. Either one
 * reloads or bounces the page in the middle of scrolling tmux history.
 */
export const gestures: Detector = async ({ page, stop, device }) => {
  const isTouch = await page.evaluate(
    () => matchMedia("(pointer: coarse)").matches,
  );
  if (!isTouch) return [];

  const result = await page.evaluate(() => {
    const surface = document.querySelector<HTMLElement>(".touch-none");
    if (!surface) return { surface: false } as const;

    /*
     * Which declared pan intents are cancelled by an ancestor.
     *
     * `touch-action` composes by *intersection* along the ancestor chain, and
     * that direction is the whole subtlety. An ancestor can only ever take
     * behaviour away, never give it back — so nothing above the gesture
     * surface can undo its `none`, and checking for that was checking for
     * something the CSS spec makes impossible.
     *
     * The real hazard runs the other way, and this app has already been bitten
     * by it: `window-tabs.tsx` declares `touch-pan-x` because it is a genuine
     * horizontal scroller, and it "used to inherit `pan-y` from a wrapper" —
     * an intersection of `pan-x` and `pan-y` is `none`, and the strip simply
     * stopped scrolling. So the check is: for every element that asks for a
     * pan, is that pan still permitted once its ancestors have had their say?
     */
    const lostPans: { tag: string; wants: string; blockedBy: string }[] = [];
    for (const el of Array.from(document.querySelectorAll<HTMLElement>("*"))) {
      const own = getComputedStyle(el).touchAction;
      if (!/^pan-/.test(own)) continue;
      const axis = own.startsWith("pan-x") ? "x" : "y";
      let node = el.parentElement;
      while (node) {
        const parent = getComputedStyle(node).touchAction;
        const blocks =
          parent === "none" ||
          (axis === "x" && /^pan-y/.test(parent)) ||
          (axis === "y" && /^pan-x/.test(parent));
        if (blocks) {
          lostPans.push({
            tag:
              el.tagName.toLowerCase() +
              (el.getAttribute("aria-label")
                ? `[aria-label="${el.getAttribute("aria-label")}"]`
                : ""),
            wants: own,
            blockedBy: `${node.tagName.toLowerCase()} touch-action: ${parent}`,
          });
          break;
        }
        node = node.parentElement;
      }
    }

    const rect = surface.getBoundingClientRect();
    const body = getComputedStyle(document.body);
    const html = getComputedStyle(document.documentElement);

    return {
      surface: true as const,
      surfaceTouchAction: getComputedStyle(surface).touchAction,
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      lostPans: lostPans.slice(0, 8),
      overscroll: {
        html: html.overscrollBehaviorY,
        body: body.overscrollBehaviorY,
      },
    };
  });

  const findings: Finding[] = [];
  const add = (
    id: string,
    detail: string,
    severity: Finding["severity"] = "major",
    measured?: Finding["measured"],
  ) =>
    findings.push({
      id: findingId("gestures", id, device),
      severity,
      detector: "gestures",
      detail,
      where: `${stop.session}/${stop.state}`,
      measured,
    });

  if (!result.surface) {
    add(
      "no-surface",
      "no element with `touch-none` is present, so the terminal has no " +
        "gesture surface and no touch gesture can work at all",
      "blocker",
    );
    return findings;
  }

  if (result.surfaceTouchAction !== "none") {
    add(
      "surface-touch-action",
      `the gesture surface computes touch-action: ${result.surfaceTouchAction}, ` +
        "not none — the UA can commit to a pan first, and on iOS every " +
        "touchmove after that is non-cancelable",
      "blocker",
      { touchAction: result.surfaceTouchAction },
    );
  }

  for (const lost of result.lostPans) {
    add(
      `pan-blocked-${lost.tag}`,
      `${lost.tag} asks for ${lost.wants} but an ancestor (${lost.blockedBy}) ` +
        "intersects it away — that element cannot be panned or scrolled by touch",
      "major",
    );
  }

  if (result.width === 0 || result.height === 0) {
    add(
      "surface-not-laid-out",
      `the gesture surface is ${result.width}x${result.height} — it is in the ` +
        "DOM but has no area, so no touch can land on it",
      "blocker",
      { width: result.width, height: result.height },
    );
  }

  if (
    result.overscroll.html !== "none" &&
    result.overscroll.html !== "contain" &&
    result.overscroll.body !== "none" &&
    result.overscroll.body !== "contain"
  ) {
    add(
      "overscroll",
      "neither <html> nor <body> constrains overscroll-behavior-y, so a drag " +
        "that reaches the top of the document triggers pull-to-refresh on " +
        "Android and rubber-banding on iOS mid-scroll",
      "major",
      { html: result.overscroll.html, body: result.overscroll.body },
    );
  }

  /*
   * `user-select` is deliberately not checked.
   *
   * It looks like it belongs here — a native text selection starting mid-drag
   * is exactly the kind of thing that makes a gesture feel broken — but
   * selecting terminal text *is* how copy works on a phone, and xterm owns
   * that selection. Demanding `user-select: none` would report the feature as
   * the defect. The real version of that bug was a latched guard, and it is
   * covered behaviourally in `gestures.spec.ts`.
   */

  return findings;
};
