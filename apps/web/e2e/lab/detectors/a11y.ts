import AxeBuilder from "@axe-core/playwright";
import { findingId, type Detector, type Finding } from "./types";

/**
 * WCAG 2.2 A and AA, with a reviewed exclusion list rather than a blanket one.
 *
 * ## The one exclusion, and why it is not a cop-out
 *
 * xterm's own subtree is excluded. It is a canvas with a hidden textarea and a
 * screen-reader mode of its own design; axe has no way to evaluate a terminal
 * emulator and reports its internals as colour-contrast and region failures on
 * every run. Excluding it would hide real findings if the terminal's *chrome*
 * were inside it — it is not: the chrome is the toolbar, the tabs, the nav and
 * the sheets, all siblings. The container element itself keeps its `role` and
 * `aria-label`, and `ux.ts` asserts those independently.
 *
 * Nothing else is excluded. A rule that fires on our own markup is a finding,
 * and the ratchet is where the decision to accept one temporarily is recorded
 * — visibly, with a count that can only go down.
 */
export const a11y: Detector = async ({ page, stop, device }) => {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .exclude(".xterm")
    .analyze();

  return results.violations.map((v): Finding => {
    const target = v.nodes[0]?.target?.join(" ") ?? "";
    return {
      id: findingId("a11y", v.id, target, device),
      // axe's own severity, mapped rather than reinvented. "critical" and
      // "serious" are things that stop someone using the app; "moderate" and
      // "minor" are things that make it worse.
      severity:
        v.impact === "critical"
          ? "blocker"
          : v.impact === "serious"
            ? "major"
            : "minor",
      detector: "a11y",
      detail: `${v.id}: ${v.help} (${v.nodes.length} node${v.nodes.length === 1 ? "" : "s"})`,
      where: `${stop.session}/${stop.state} ${target}`,
      measured: { nodes: v.nodes.length, impact: v.impact ?? "unknown" },
    };
  });
};
