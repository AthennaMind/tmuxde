import type { Page } from "@playwright/test";
import type { LabFixture, LabTerminal } from "./fixtures";
import { tmuxFormat, type LabSession } from "./lab";
import {
  PAGE_DETECTORS,
  fidelityFindings,
  reflowFindings,
  type Finding,
  type Stop,
} from "./detectors";

/**
 * Walk the product's state space, running the full battery at every stop.
 *
 * This is what turns "check the mobile UI" into a sweep rather than a spot
 * check. The app's states are the cross product of: which session is attached,
 * which window and pane within it, whether the sidebar or pane list is open,
 * and — on a phone — which bottom-nav tab is showing. A bug in any one of them
 * is invisible from any other.
 *
 * ## Why the walk is driven through the UI
 *
 * Switching window by asking tmux directly would prove tmux works. Every step
 * here clicks the control a person would click, and then asks *tmux* whether
 * the thing that person wanted actually happened. That pairing is the point:
 * the chrome and the effect are checked against each other, which is the one
 * way to catch "the dot moves but the view doesn't" — a bug this app has
 * already had, and the reason `resolveStrip` is shared between the strip and
 * the swipe handler.
 */

export interface SweepOptions {
  device: string;
  /** Sessions to visit. A short list keeps an iteration loop usable. */
  sessions: readonly LabSession[];
  /** Skip the per-stop fidelity diff for sessions whose output moves. */
  volatile?: readonly string[];
}

/** Sessions whose content changes between two readings, by construction. */
export const VOLATILE_SESSIONS = [
  "firehose",
  "drip",
  "progress",
  "altscreen",
] as const;

async function runPageDetectors(
  page: Page,
  stop: Stop,
  device: string,
): Promise<Finding[]> {
  const out: Finding[] = [];
  for (const detector of PAGE_DETECTORS) {
    out.push(...(await detector({ page, stop, device })));
  }
  return out;
}

/**
 * Everything checkable at one stop.
 *
 * Fidelity and reflow are separated from the page detectors because they need
 * tmux, and they are skipped for a volatile session — not because the check is
 * unwanted there, but because a diff between two readings of a moving target
 * reports noise as a defect, which is worse than not checking. Moving sessions
 * are covered by `perf.ts` and by the fidelity check in `streaming.spec.ts`,
 * which quiesces the session first.
 */
export async function inspectStop(
  page: Page,
  term: LabTerminal,
  stop: Stop,
  device: string,
  opts: { volatile?: boolean } = {},
): Promise<Finding[]> {
  const findings = await runPageDetectors(page, stop, device);
  const snapshot = await term.snapshot();
  findings.push(...reflowFindings(snapshot, stop, device));
  if (!opts.volatile) {
    findings.push(...fidelityFindings(snapshot, stop, device));
  }
  return findings;
}

/** The window tab strip, when the current session has more than one window. */
const windowTabs = (page: Page) =>
  page.getByRole("tablist", { name: "Windows" }).getByRole("tab");

const paneTabs = (page: Page) =>
  page.getByRole("tablist", { name: "Panes" }).getByRole("tab");

/**
 * Click every window tab, confirming with tmux that the window actually moved.
 *
 * `#{window_index}` from tmux is the ground truth. Asserting on the strip's own
 * `aria-selected` would be asking the component whether it agrees with itself.
 */
export async function walkWindows(
  page: Page,
  term: LabTerminal,
  session: string,
  device: string,
): Promise<Finding[]> {
  const findings: Finding[] = [];
  const tabs = windowTabs(page);
  const count = await tabs.count();
  if (count < 2) return findings;

  for (let i = 0; i < count; i++) {
    const tab = tabs.nth(i);
    const label = (await tab.innerText()).trim().replace(/\s+/g, " ");
    const previous = tmuxFormat(session, "#{window_index}");
    await tab.click();

    // The switch is optimistic — the strip dims a pending entry — so this has
    // to wait for tmux, not for the DOM.
    const settled = await waitForTmux(
      () => tmuxFormat(session, "#{window_index}"),
      (value) => value !== previous,
      2000,
    );

    const stop: Stop = { session, state: `window:${label}` };
    if (!settled.changed && i > 0) {
      findings.push({
        id: `window-switch:${session}:${label}:${device}`,
        severity: "blocker",
        detector: "navigation",
        detail:
          `clicking the "${label}" window tab left tmux on window ` +
          `${settled.value} — the strip moved and the session did not`,
        where: `${session}/${stop.state}`,
      });
      continue;
    }

    findings.push(...(await inspectStop(page, term, stop, device)));
  }

  return findings;
}

/** The same walk for panes, which on a phone live in their own strip. */
export async function walkPanes(
  page: Page,
  term: LabTerminal,
  session: string,
  device: string,
): Promise<Finding[]> {
  const findings: Finding[] = [];
  const tabs = paneTabs(page);
  const count = await tabs.count();
  if (count < 2) return findings;

  for (let i = 0; i < count; i++) {
    const tab = tabs.nth(i);
    const label = (await tab.innerText()).trim().replace(/\s+/g, " ");
    const previous = tmuxFormat(session, "#{pane_index}");
    await tab.click();

    const settled = await waitForTmux(
      () => tmuxFormat(session, "#{pane_index}"),
      (value) => value !== previous,
      2000,
    );

    const stop: Stop = { session, state: `pane:${label}` };
    if (!settled.changed && i > 0) {
      findings.push({
        id: `pane-switch:${session}:${label}:${device}`,
        severity: "blocker",
        detector: "navigation",
        detail:
          `clicking the "${label}" pane tab left tmux on pane ` +
          `${settled.value} — the strip moved and the session did not`,
        where: `${session}/${stop.state}`,
      });
      continue;
    }

    findings.push(...(await inspectStop(page, term, stop, device)));
  }

  return findings;
}

/**
 * Poll tmux until a value changes, or give up.
 *
 * Polling rather than waiting on an event because tmux has no push channel
 * here — and because "it never changed" is precisely the finding, so the
 * timeout is a result rather than an error.
 */
async function waitForTmux(
  read: () => string,
  done: (value: string) => boolean,
  timeoutMs: number,
): Promise<{ changed: boolean; value: string }> {
  const deadline = Date.now() + timeoutMs;
  let value = read();
  while (Date.now() < deadline) {
    if (done(value)) return { changed: true, value };
    await new Promise((r) => setTimeout(r, 100));
    value = read();
  }
  return { changed: done(value), value };
}

/**
 * The full sweep: every named session, plus the window and pane walks.
 */
export async function sweep(
  page: Page,
  lab: LabFixture,
  opts: SweepOptions,
): Promise<Finding[]> {
  const findings: Finding[] = [];
  const volatile = new Set<string>(opts.volatile ?? VOLATILE_SESSIONS);

  let first = true;
  for (const session of opts.sessions) {
    const term = first ? await lab.open(session) : await lab.switchTo(session);
    first = false;

    findings.push(
      ...(await inspectStop(
        page,
        term,
        { session, state: "attached" },
        opts.device,
        { volatile: volatile.has(session) },
      )),
    );

    if (session === "many-windows") {
      findings.push(...(await walkWindows(page, term, session, opts.device)));
    }
    if (session === "many-panes") {
      findings.push(...(await walkPanes(page, term, session, opts.device)));
    }
  }

  return findings;
}
