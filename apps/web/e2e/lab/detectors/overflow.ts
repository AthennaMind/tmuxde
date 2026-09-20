import { findingId, type Detector, type Finding } from "./types";

/**
 * Nothing may stick out of the viewport horizontally.
 *
 * The highest-yield phone check there is, and the one with the most direct
 * evidence behind it: this repo already shipped "a header that overflows a
 * phone" because no dashboard assertion had ever run at 390px.
 *
 * ## Why `documentElement.scrollWidth` alone is not enough
 *
 * It answers "is the page scrollable sideways", which is the symptom, not the
 * cause — and it is silent when the offender is inside a clipped ancestor,
 * where the content is unreachable rather than merely off to the right. Both
 * are defects: one you can scroll to, one you cannot. So this walks elements
 * and reports the widest offender by name, and reports the page-level symptom
 * separately.
 *
 * Elements that are *deliberately* wider than the viewport and scrolled within
 * their own box — the window tab strip is the obvious one — are not defects.
 * They are recognised by having a scrollable ancestor on the x axis, which is
 * exactly what makes the overflow reachable.
 */
export const overflow: Detector = async ({ page, stop, device }) => {
  const result = await page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const offenders: { label: string; right: number; width: number }[] = [];

    const describe = (el: Element): string => {
      const id = el.id ? `#${el.id}` : "";
      const testid = el.getAttribute("data-testid");
      const aria = el.getAttribute("aria-label");
      const cls =
        typeof el.className === "string" && el.className
          ? `.${el.className.trim().split(/\s+/).slice(0, 3).join(".")}`
          : "";
      return `${el.tagName.toLowerCase()}${id}${testid ? `[data-testid=${testid}]` : ""}${aria ? `[aria-label="${aria}"]` : ""}${cls}`;
    };

    /** True when some ancestor can actually scroll this into view. */
    const scrollableAncestor = (el: Element): boolean => {
      let node: Element | null = el.parentElement;
      while (node && node !== document.documentElement) {
        const style = getComputedStyle(node);
        const overflowX = style.overflowX;
        if (
          (overflowX === "auto" || overflowX === "scroll") &&
          node.scrollWidth > node.clientWidth
        ) {
          return true;
        }
        node = node.parentElement;
      }
      return false;
    };

    for (const el of Array.from(document.body.querySelectorAll("*"))) {
      const style = getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") continue;
      // A canvas is sized in device pixels by its renderer; its CSS box is what
      // matters and is measured through the element itself, not its content.
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue;
      // Two CSS pixels of slack. Sub-pixel layout rounds, and a report full of
      // 0.4px "overflows" is a report nobody reads.
      if (rect.right <= vw + 2 && rect.left >= -2) continue;
      if (scrollableAncestor(el)) continue;
      offenders.push({
        label: describe(el),
        right: Math.round(rect.right),
        width: Math.round(rect.width),
      });
    }

    return {
      vw,
      docScrollWidth: document.documentElement.scrollWidth,
      // Deduplicated by label: one overflowing flex row usually drags a dozen
      // descendants out with it, and naming the row is the actionable finding.
      offenders: offenders.slice(0, 12),
    };
  });

  const findings: Finding[] = [];

  if (result.docScrollWidth > result.vw + 2) {
    findings.push({
      id: findingId("overflow", "document", device),
      severity: "major",
      detector: "overflow",
      detail:
        `the page scrolls horizontally: ${result.docScrollWidth}px of content ` +
        `in a ${result.vw}px viewport`,
      where: "document",
      measured: { scrollWidth: result.docScrollWidth, viewport: result.vw },
    });
  }

  const seen = new Set<string>();
  for (const o of result.offenders) {
    if (seen.has(o.label)) continue;
    seen.add(o.label);
    findings.push({
      id: findingId("overflow", o.label, device),
      severity: "major",
      detector: "overflow",
      detail:
        `${o.label} extends to ${o.right}px, past the ${result.vw}px viewport, ` +
        "and no ancestor scrolls it into reach",
      where: `${stop.session}/${stop.state}`,
      measured: { right: o.right, width: o.width, viewport: result.vw },
    });
  }

  return findings;
};
