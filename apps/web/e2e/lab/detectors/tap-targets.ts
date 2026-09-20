import { MIN_TAP_PX } from "../../tap-target";
import { findingId, type Detector, type Finding } from "./types";

/**
 * Every interactive element, not a hand-picked list.
 *
 * `e2e/tap-target.ts` already holds the floor and the reasoning for it; this is
 * the same number applied exhaustively. The distinction matters: the three
 * controls that shipped under the floor were all the *primary* action on the
 * surface they lived on, and each was missed because somebody had to think to
 * check it. A sweep does not have to think.
 *
 * Height only, for the reason `tap-target.ts` gives: width is often
 * legitimately narrower for an icon in a row of icons, and the vertical axis is
 * where a thumb misses.
 *
 * Desktop is exempt. WCAG 2.5.8 is about touch, a mouse is precise, and
 * reporting every 32px desktop menu item would bury the phone findings this
 * exists to surface.
 */
export const tapTargets: Detector = async ({ page, stop, device }) => {
  const isTouch = await page.evaluate(
    () => matchMedia("(pointer: coarse)").matches,
  );
  if (!isTouch) return [];

  const offenders = await page.evaluate((floor) => {
    const SELECTOR = [
      "button",
      "a[href]",
      "input:not([type=hidden])",
      "select",
      "textarea",
      "[role=button]",
      "[role=tab]",
      "[role=menuitem]",
      "[role=switch]",
      "[role=checkbox]",
      "[tabindex]:not([tabindex='-1'])",
    ].join(",");

    const describe = (el: Element): string => {
      const label =
        el.getAttribute("aria-label") ??
        el.getAttribute("title") ??
        (el.textContent ?? "").trim().slice(0, 40);
      return `${el.tagName.toLowerCase()}${label ? ` "${label}"` : ""}`;
    };

    /*
     * A component identity, not an instance one.
     *
     * Keyed on the label, twelve window tabs that are all 43px tall because
     * one class list says so became twelve findings — and the fix for all of
     * them is one edit in one file. Keyed on the class list they become one
     * finding with an example and a count, which is what a backlog entry
     * should look like. The label still appears in the detail, because "which
     * button" is the first thing anyone asks.
     */
    const signature = (el: Element): string => {
      const cls =
        typeof el.className === "string" && el.className
          ? el.className.trim().split(/\s+/).slice(0, 4).join(".")
          : "";
      const role = el.getAttribute("role");
      return `${el.tagName.toLowerCase()}${role ? `[role=${role}]` : ""}${cls ? `.${cls}` : ""}`;
    };

    const out: {
      label: string;
      signature: string;
      height: number;
      width: number;
    }[] = [];
    for (const el of Array.from(document.querySelectorAll(SELECTOR))) {
      const style = getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") continue;
      if (style.pointerEvents === "none") continue;
      if (el.hasAttribute("disabled")) continue;
      /*
       * xterm's internals are not tap targets.
       *
       * The emulator keeps a hidden `textarea` to receive keystrokes. It has a
       * size, an accessible name and a `tabindex`, so it matches every
       * selector above — and nobody has ever tapped it, because the thing a
       * finger lands on is the canvas in front of it. Reporting it produced
       * one finding per stop for a control that does not exist as far as a
       * user is concerned.
       */
      if (el.closest(".xterm")) continue;
      const rect = el.getBoundingClientRect();
      // Zero-size elements are not rendered controls — xterm's helper textarea
      // is the canonical example, and it is not something anybody taps.
      if (rect.width === 0 || rect.height === 0) continue;
      // Off-screen controls belong to a closed sheet or a collapsed menu. They
      // are measured when the navigator opens them, not here.
      if (rect.bottom < 0 || rect.top > window.innerHeight) continue;
      if (rect.height + 0.5 >= floor) continue;
      out.push({
        label: describe(el),
        signature: signature(el),
        height: Math.round(rect.height * 10) / 10,
        width: Math.round(rect.width),
      });
    }
    return out;
  }, MIN_TAP_PX);

  const findings: Finding[] = [];
  const seen = new Set<string>();
  for (const o of offenders) {
    if (seen.has(o.signature)) continue;
    seen.add(o.signature);
    findings.push({
      id: findingId("tap-target", o.signature, device),
      severity: "major",
      detector: "tap-targets",
      detail:
        `${o.signature} is ${o.height}px tall, under the ${MIN_TAP_PX}px floor ` +
        `(e.g. ${o.label})`,
      where: `${stop.session}/${stop.state}`,
      measured: { height: o.height, width: o.width, floor: MIN_TAP_PX },
    });
  }
  return findings;
};
