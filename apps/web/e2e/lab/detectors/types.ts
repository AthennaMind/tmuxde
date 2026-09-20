import type { Page } from "@playwright/test";

/**
 * A detector is a pure function over a page state that returns findings.
 *
 * ## Why findings and not assertions
 *
 * An `expect` stops at the first failure. That is right for a spec, which asks
 * one question, and wrong for a sweep, which asks nine questions at every one
 * of dozens of stops and needs to come back with *all* the answers so they can
 * be ranked. A detector that threw would hide every problem behind whichever
 * one happened to be first, and the loop in `scripts/lab-loop.mjs` would fix
 * them one run at a time forever.
 *
 * So detectors report. `e2e/lab/regressions.spec.ts` and the sweep both consume
 * the same functions; the spec turns findings into assertions at its own
 * boundary, and the sweep ranks them.
 */
export type Severity = "blocker" | "major" | "minor";

export interface Finding {
  /** Stable across runs, so the ratchet can count it. No coordinates, no ids. */
  id: string;
  severity: Severity;
  /** Which detector produced it. */
  detector: string;
  /** What is wrong, in one sentence a reader can act on. */
  detail: string;
  /** A selector or label naming the element, when there is one. */
  where?: string;
  /** Numbers behind the judgement, so a report does not have to be believed. */
  measured?: Record<string, number | string | boolean>;
}

/** Where in the product's state space this reading was taken. */
export interface Stop {
  session: string;
  /** e.g. `window:3`, `pane:2`, `sidebar:open`, `keyboard:open`. */
  state: string;
}

export interface DetectorContext {
  page: Page;
  stop: Stop;
  /** The project name, so a finding can be attributed to a device. */
  device: string;
}

export type Detector = (ctx: DetectorContext) => Promise<Finding[]>;

/** Build a finding id that is stable across runs but distinct per subject. */
export function findingId(detector: string, ...parts: string[]): string {
  return [detector, ...parts]
    .join(":")
    .toLowerCase()
    .replace(/[^a-z0-9:_-]+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 160);
}
