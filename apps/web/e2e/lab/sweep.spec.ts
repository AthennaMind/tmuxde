import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "./fixtures";
import { sweep } from "./navigator";
import { consoleFindings, type Finding } from "./detectors";
import type { LabSession } from "./lab";

/**
 * The sweep: every detector at every stop, reported rather than asserted.
 *
 * ## Why this spec never fails
 *
 * It writes findings to `lab-report/<project>.json` and passes. That looks
 * wrong for a test and is deliberate — the sweep is an instrument, not a gate.
 * `scripts/lab-loop.mjs` is the gate: it reads every project's report, compares
 * the counts against `ratchet.json`, and fails when any of them rises. Making
 * the sweep itself fail would stop it at the first stop that had a problem,
 * and the whole point is to come back with all of them so they can be ranked.
 *
 * The specs that *do* assert — `smoke`, `gestures`, `streaming`, `regressions`
 * — use the same detectors at their own boundaries.
 */

/**
 * Which sessions a sweep visits.
 *
 * Not all thirteen by default. Each session costs a reload, an attach and a
 * full battery on five projects, and a loop that takes half an hour is a loop
 * nobody runs. These nine cover every distinct *shape* of state: a quiet
 * session, heavy scrollback, wide reflow, the alternate screen, many windows,
 * many panes, and the three output profiles most likely to break rendering.
 * `LAB_SWEEP_SESSIONS` overrides it for a full run.
 */
const DEFAULT_SESSIONS: LabSession[] = [
  "idle",
  "unicode",
  "colors",
  "longlines",
  "scrollback",
  "altscreen",
  "many-windows",
  "many-panes",
  "ctrlseq",
];

const sessions = (
  process.env.LAB_SWEEP_SESSIONS
    ? (process.env.LAB_SWEEP_SESSIONS.split(",").map((s) =>
        s.trim(),
      ) as LabSession[])
    : DEFAULT_SESSIONS
).filter(Boolean);

const REPORT_DIR = path.resolve(
  process.env.LAB_REPORT_DIR ?? path.join(process.cwd(), "lab-report"),
);

test.describe("sweep", { tag: "@terminal" }, () => {
  // A full sweep is many attaches on five projects; the default budget is for
  // a single question, and this asks a few hundred.
  test.setTimeout(10 * 60_000);

  test("every detector at every stop", async ({ lab, page }, testInfo) => {
    const device = testInfo.project.name;

    const raw: Finding[] = await sweep(page, lab, { device, sessions });

    // Collected since before the first navigation, so it includes anything
    // thrown during hydration — which is where the errors worth having are.
    raw.push(...consoleFindings(lab.problems, device, "sweep"));

    /*
     * One finding per defect, with a count of where it was seen.
     *
     * The first sweep returned 527 findings and about 30 distinct problems:
     * a 24px "Switch machine" button is one defect, not the twenty-one stops
     * it happens to be visible at. Left undeduplicated the report is unusable
     * as a backlog and the ratchet is unusable as a gate — a count that moves
     * because a sweep visited a different number of sessions is not a signal.
     *
     * `seenAt` is kept rather than discarded: "this only happens on the
     * many-panes session" and "this is everywhere" are different bugs, and the
     * list is the only thing that distinguishes them.
     */
    const byId = new Map<
      string,
      Finding & { occurrences: number; seenAt: string[] }
    >();
    for (const finding of raw) {
      const existing = byId.get(finding.id);
      if (existing) {
        existing.occurrences += 1;
        if (finding.where && !existing.seenAt.includes(finding.where)) {
          existing.seenAt.push(finding.where);
        }
        continue;
      }
      byId.set(finding.id, {
        ...finding,
        occurrences: 1,
        seenAt: finding.where ? [finding.where] : [],
      });
    }

    const order = { blocker: 0, major: 1, minor: 2 } as const;
    const findings = [...byId.values()].sort(
      (a, b) =>
        order[a.severity] - order[b.severity] || b.occurrences - a.occurrences,
    );

    mkdirSync(REPORT_DIR, { recursive: true });
    writeFileSync(
      path.join(REPORT_DIR, `${device}.json`),
      JSON.stringify(
        {
          device,
          at: new Date().toISOString(),
          viewport: page.viewportSize(),
          sessions,
          total: raw.length,
          findings,
        },
        null,
        2,
      ) + "\n",
    );

    // Attached to the Playwright report as well, so a CI run shows the
    // findings without anyone having to fetch a file off the runner.
    await testInfo.attach(`lab-findings-${device}.json`, {
      body: JSON.stringify(findings, null, 2),
      contentType: "application/json",
    });

    const bySeverity = findings.reduce<Record<string, number>>((acc, f) => {
      acc[f.severity] = (acc[f.severity] ?? 0) + 1;
      return acc;
    }, {});
    console.log(
      `[${device}] ${findings.length} distinct findings ` +
        `(${raw.length} occurrences) across ${sessions.length} sessions:`,
      bySeverity,
    );
  });
});
