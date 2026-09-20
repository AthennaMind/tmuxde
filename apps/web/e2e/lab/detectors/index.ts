/**
 * The detector library.
 *
 * Split by shape rather than by subject, because the two kinds compose
 * differently: a `Detector` reads the page and nothing else, so the navigator
 * can run all of them at every stop with no arguments; the others need
 * something the page cannot provide — tmux's own rendering, a sampling window,
 * the console log collected since navigation — and are called explicitly by
 * the specs that have it.
 */
export * from "./types";

export { overflow } from "./overflow";
export { tapTargets } from "./tap-targets";
export { keyboard } from "./keyboard";
export { gestures } from "./gestures";
export { ux } from "./ux";
export { a11y } from "./a11y";

export { fidelityFindings } from "./fidelity";
export { reflowFindings } from "./reflow";
export { perfFindings, DEFAULT_BUDGET } from "./perf";
export { consoleFindings } from "./console";

import { overflow } from "./overflow";
import { tapTargets } from "./tap-targets";
import { gestures } from "./gestures";
import { ux } from "./ux";
import { a11y } from "./a11y";
import type { Detector } from "./types";

/**
 * Detectors cheap enough to run at every stop of a sweep.
 *
 * `keyboard` is deliberately absent: it mutates `visualViewport` and waits for
 * the app to settle twice, which is seconds per stop and would make a full
 * sweep take an hour. It is run at the stops where the keyboard is the subject.
 */
export const PAGE_DETECTORS: Detector[] = [
  overflow,
  tapTargets,
  gestures,
  ux,
  a11y,
];
