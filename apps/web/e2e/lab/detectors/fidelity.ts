import { capturePane, tmuxFormat } from "../lab";
import { findingId, type Finding, type Stop } from "./types";
import type { TerminalSnapshot } from "@/components/terminal/terminal-handle";

/**
 * The decisive detector: what the client rendered against what tmux rendered.
 *
 * ## Why this is the only check that can see the real failures
 *
 * tmux composites server-side. The browser receives one linear ANSI stream of
 * tmux's own output — there is no client-side pane composition — so the only
 * statement of what *should* be on screen is tmux's own `capture-pane`, and
 * the only statement of what *is* on screen is xterm's buffer. A screenshot
 * cannot tell a dropped byte from a slow paint, and the DOM does not contain
 * the text at all, because the WebGL renderer paints to a canvas.
 *
 * Four defect classes show up here and nowhere else: bytes dropped under load,
 * a line wrapped at a different column than tmux wrapped it, a wide character
 * measured as one cell (which shifts every column after it on that row), and a
 * cell left stale by a repaint that never happened.
 *
 * ## Why trailing blanks are trimmed and nothing else is
 *
 * tmux stops emitting at its last non-empty row; the client always holds a
 * full grid. That is a difference in representation, not in content. Every
 * other difference is real and is reported.
 */
export interface FidelityOptions {
  /** A pane target for `capture-pane`; defaults to the session name. */
  target?: string;
  /**
   * Rows expected to differ legitimately, as indices from the top.
   *
   * Only one thing qualifies: a row carrying a live clock or counter, which is
   * a different value by the time the second reading is taken. Anything else
   * being listed here is a bug being hidden.
   */
  volatileRows?: number[];
}

const trim = (lines: string[]): string[] => {
  const out = lines.map((l) => l.replace(/\s+$/, ""));
  while (out.length > 0 && out[out.length - 1] === "") out.pop();
  return out;
};

export function fidelityFindings(
  snapshot: TerminalSnapshot,
  stop: Stop,
  device: string,
  options: FidelityOptions = {},
): Finding[] {
  const target = options.target ?? stop.session;
  const volatile = new Set(options.volatileRows ?? []);

  const rendered = trim(snapshot.lines);
  const truth = trim(capturePane(target).split("\n"));

  const findings: Finding[] = [];

  /*
   * A split window is not a row-for-row question.
   *
   * `capture-pane` captures **one pane**. The client is showing tmux's
   * composite of every pane in the window, separator columns and all, so on a
   * six-pane window the diff reads "the client has 36 rows where tmux has 1"
   * — which says nothing about the client and everything about the two
   * readings not being of the same thing. Reassembling the composite from the
   * panes and the layout would be reimplementing tmux, in a detector whose job
   * is to be the independent witness.
   *
   * So the claim narrows to one that survives: every line the active pane
   * holds is on screen, in order. That still catches a dropped byte, a stale
   * cell and a line that never arrived — it stops claiming to catch a pane
   * placed at the wrong column, which `capture-pane` cannot see either.
   *
   * A zoomed window is excluded: tmux composites one pane to the full window,
   * so the strict diff is exactly right there and is what runs.
   */
  const panes = Number(tmuxFormat(target, "#{window_panes}"));
  const zoomed = tmuxFormat(target, "#{window_zoomed_flag}") === "1";
  if (panes > 1 && !zoomed) {
    return splitFindings(rendered, truth, stop, device, panes);
  }

  if (rendered.length !== truth.length) {
    findings.push({
      id: findingId("fidelity", "row-count", stop.session, device),
      severity: "major",
      detector: "fidelity",
      detail:
        `the client shows ${rendered.length} non-blank rows where tmux has ` +
        `${truth.length} — content was lost, gained or wrapped differently`,
      where: `${stop.session}/${stop.state}`,
      measured: {
        client: rendered.length,
        tmux: truth.length,
        cols: snapshot.cols,
        rows: snapshot.rows,
      },
    });
  }

  for (let i = 0; i < Math.min(rendered.length, truth.length); i++) {
    if (volatile.has(i)) continue;
    if (rendered[i] === truth[i]) continue;

    // Reported once per row with both readings inline. A diff that says only
    // "row 7 differs" sends the reader to a trace viewer; this does not.
    findings.push({
      id: findingId("fidelity", "row", String(i), stop.session, device),
      severity: "blocker",
      detector: "fidelity",
      detail:
        `row ${i} differs from tmux\n` +
        `  client: ${JSON.stringify(rendered[i])}\n` +
        `  tmux:   ${JSON.stringify(truth[i])}`,
      where: `${stop.session}/${stop.state}`,
      measured: {
        row: i,
        clientLength: rendered[i]?.length ?? 0,
        tmuxLength: truth[i]?.length ?? 0,
      },
    });

    // Three is enough to diagnose; a whole grid of them is the same defect
    // reported forty times and makes the ratchet meaningless.
    if (findings.length >= 4) break;
  }

  return findings;
}

/**
 * The weaker claim, for a window the client composites and tmux does not.
 *
 * Containment in order, not equality: each of the active pane's lines has to
 * appear inside some rendered row, and the rows have to be in the same
 * sequence. A pane's line is a *substring* of the composited row because the
 * pane occupies a column range of it, which is precisely why equality cannot
 * be asked for here.
 */
function splitFindings(
  rendered: string[],
  truth: string[],
  stop: Stop,
  device: string,
  panes: number,
): Finding[] {
  const findings: Finding[] = [];
  let from = 0;

  for (const line of truth) {
    if (line.trim() === "") continue;
    const at = rendered.findIndex((row, i) => i >= from && row.includes(line));
    if (at === -1) {
      findings.push({
        id: findingId("fidelity", "missing", stop.session, device),
        severity: "blocker",
        detector: "fidelity",
        detail:
          `a line tmux has in the active pane is not on screen, or is out ` +
          `of order\n  tmux: ${JSON.stringify(line)}`,
        where: `${stop.session}/${stop.state}`,
        measured: { panes, searchedFrom: from, rows: rendered.length },
      });
      break;
    }
    from = at + 1;
  }

  return findings;
}
