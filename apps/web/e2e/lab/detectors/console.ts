import { findingId, type Finding } from "./types";

/**
 * Anything the browser complained about, turned into findings.
 *
 * Not a `Detector` — it has no page state to read. The collection happens in
 * the fixture, before the first navigation, because the errors most worth
 * catching are the ones thrown during hydration and those have already
 * happened by the time a detector could run.
 *
 * ## What is ignored, and why each one
 *
 * Three classes of noise, all of them dev-server artefacts rather than product
 * defects. Everything else is a finding: a React key warning, a failed fetch,
 * an unhandled rejection and an `act()` warning are all things that were true
 * of the product at the moment somebody looked.
 */
const IGNORED = [
  // `next dev` tears its HMR socket down on every route change.
  /webpack-hmr/,
  /Fast Refresh/,
  // The dev overlay's own preload accounting, not ours.
  /was preloaded using link preload but not used/,
  // React's development-only advertisement.
  /Download the React DevTools/,
];

export function consoleFindings(
  problems: readonly string[],
  device: string,
  where: string,
): Finding[] {
  const findings: Finding[] = [];
  const seen = new Set<string>();

  for (const problem of problems) {
    if (IGNORED.some((re) => re.test(problem))) continue;
    // Keyed on the message with numbers stripped, so the same error at three
    // stops is one finding rather than three — and so a counter embedded in a
    // message cannot make a stable problem look new on every run.
    const key = problem.replace(/\d+/g, "#").slice(0, 120);
    if (seen.has(key)) continue;
    seen.add(key);

    findings.push({
      id: findingId("console", key, device),
      // A page error is a crash of something; a console error is a report of
      // something already handled. Both matter, they do not matter equally.
      severity: /^pageerror:/.test(problem) ? "blocker" : "major",
      detector: "console",
      detail: problem.slice(0, 400),
      where,
    });
  }

  return findings;
}
