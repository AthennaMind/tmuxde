import { findingId, type Finding, type Stop } from "./types";
import type { Page } from "@playwright/test";

/**
 * What a firehose costs.
 *
 * ## The defect this exists to prove
 *
 * `cast-player.tsx` paces *recording* playback into 1 MiB `terminal.write()`
 * calls and uses xterm's write-callback as backpressure, with the comment "so
 * the main thread stays free". The **live** path does no such thing:
 * `terminal-view.tsx` writes every `terminal:output` message to xterm the
 * instant it arrives. The slower device is the one without the batching, which
 * is backwards. The `firehose` profile is built to produce the load; this is
 * what measures the consequence.
 *
 * ## Why percentiles and not a single reading
 *
 * A firehose is timing-sensitive by nature and a single slow frame proves
 * nothing — a GC pause, another test's teardown, the CI runner's neighbour.
 * Asserting on p90 over a window of samples is the difference between a
 * detector and a flake generator.
 */
export interface PerfBudget {
  /** p90 of the longest frame gap, in ms. 50ms ≈ dropping every third frame. */
  longFrameP90Ms: number;
  /** Absolute worst frame tolerated at all, in ms. */
  worstFrameMs: number;
  /** Heap growth over the sample window, in MiB. */
  heapGrowthMiB: number;
}

export const DEFAULT_BUDGET: PerfBudget = {
  longFrameP90Ms: 50,
  worstFrameMs: 400,
  heapGrowthMiB: 64,
};

const percentile = (values: number[], p: number): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.floor((p / 100) * sorted.length),
  );
  return sorted[index]!;
};

/**
 * Sample frame pacing and heap for `durationMs`, then judge it.
 *
 * Frame *gaps* rather than a frame rate: a page that renders nothing still
 * reports 60fps, while a main thread blocked by a synchronous `write()` shows
 * up immediately as a gap. `performance.memory` is Chromium-only and its
 * absence is not a finding — it is simply one fewer thing measured, which the
 * report says rather than silently omits.
 */
export async function perfFindings(
  page: Page,
  stop: Stop,
  device: string,
  durationMs = 4000,
  budget: PerfBudget = DEFAULT_BUDGET,
): Promise<Finding[]> {
  const sample = await page.evaluate(async (ms) => {
    const gaps: number[] = [];
     
    const mem = () =>
      (performance as any).memory?.usedJSHeapSize as number | undefined;
    const heapBefore = mem();

    await new Promise<void>((resolve) => {
      let last = performance.now();
      const deadline = last + ms;
      const tick = (now: number) => {
        gaps.push(now - last);
        last = now;
        if (now >= deadline) resolve();
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });

    const heapAfter = mem();
    return {
      // The first gap is the time from `evaluate` landing to the first frame,
      // which measures the harness, not the page.
      gaps: gaps.slice(1),
      heapBefore,
      heapAfter,
    };
  }, durationMs);

  const findings: Finding[] = [];
  const p90 = percentile(sample.gaps, 90);
  const worst = sample.gaps.length ? Math.max(...sample.gaps) : 0;

  if (p90 > budget.longFrameP90Ms) {
    findings.push({
      id: findingId("perf", "frame-p90", stop.session, device),
      severity: "major",
      detector: "perf",
      detail:
        `p90 frame gap is ${Math.round(p90)}ms under "${stop.session}" ` +
        `(budget ${budget.longFrameP90Ms}ms) — the main thread is blocked ` +
        "often enough to be felt as stutter while typing",
      where: `${stop.session}/${stop.state}`,
      measured: { p90: Math.round(p90), samples: sample.gaps.length },
    });
  }

  if (worst > budget.worstFrameMs) {
    findings.push({
      id: findingId("perf", "frame-worst", stop.session, device),
      severity: "major",
      detector: "perf",
      detail:
        `the worst frame took ${Math.round(worst)}ms under "${stop.session}" ` +
        `(budget ${budget.worstFrameMs}ms) — a freeze of that length loses ` +
        "keystrokes as far as the user is concerned",
      where: `${stop.session}/${stop.state}`,
      measured: { worst: Math.round(worst) },
    });
  }

  if (sample.heapBefore !== undefined && sample.heapAfter !== undefined) {
    const grewMiB = (sample.heapAfter - sample.heapBefore) / (1024 * 1024);
    if (grewMiB > budget.heapGrowthMiB) {
      findings.push({
        id: findingId("perf", "heap", stop.session, device),
        severity: "major",
        detector: "perf",
        detail:
          `the JS heap grew ${Math.round(grewMiB)} MiB in ${durationMs / 1000}s ` +
          `under "${stop.session}" (budget ${budget.heapGrowthMiB} MiB) — a ` +
          "long-lived session on a phone will be killed by the OS",
        where: `${stop.session}/${stop.state}`,
        measured: { grewMiB: Math.round(grewMiB) },
      });
    }
  }

  return findings;
}
