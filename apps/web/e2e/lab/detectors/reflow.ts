import { tmuxSize } from "../lab";
import { findingId, type Finding, type Stop } from "./types";
import type { TerminalSnapshot } from "@/components/terminal/terminal-handle";

/**
 * The size the client negotiated against the size tmux actually adopted.
 *
 * ## Why this is not obvious from either side alone
 *
 * The client fits xterm to its box, computes `cols`/`rows`, and sends
 * `terminal:resize`. tmux resizes the window and redraws *for every attached
 * client*. If the two disagree — because a fit was debounced away, because a
 * rotation landed between the fit and the send, or because the mount-time fit
 * ladder in `terminal-view.tsx` gave up early — the result is not an error
 * anywhere. It is a terminal that renders 80 columns of content into 40
 * columns of grid, silently, and looks like a wrapping bug.
 *
 * `FIT_DEBOUNCE_MS` and `MOUNT_FIT_RETRY_DELAYS` exist precisely because this
 * is hard to get right, and until now neither had an end-to-end assertion.
 *
 * Rows are allowed to differ by one. tmux's window height and the client's row
 * count legitimately disagree by a row when a status line is involved, and the
 * lab's tmux.conf turns the status line off — but a self-hoster's will not, so
 * a detector that demanded exact equality would be asserting the lab's config
 * rather than the app's behaviour.
 */
export function reflowFindings(
  snapshot: TerminalSnapshot,
  stop: Stop,
  device: string,
): Finding[] {
  const [tmuxCols, tmuxRows] = tmuxSize(stop.session);
  const findings: Finding[] = [];

  if (snapshot.cols === 0 || snapshot.rows === 0) {
    findings.push({
      id: findingId("reflow", "zero-size", stop.session, device),
      severity: "blocker",
      detector: "reflow",
      detail:
        `the client's grid is ${snapshot.cols}x${snapshot.rows} — the fit never ` +
        "produced a usable size, so nothing can render",
      where: `${stop.session}/${stop.state}`,
      measured: { cols: snapshot.cols, rows: snapshot.rows },
    });
    return findings;
  }

  if (snapshot.cols !== tmuxCols) {
    findings.push({
      id: findingId("reflow", "cols", stop.session, device),
      severity: "blocker",
      detector: "reflow",
      detail:
        `the client fitted ${snapshot.cols} columns but tmux is rendering ` +
        `${tmuxCols} — every line wider than ${Math.min(snapshot.cols, tmuxCols)} ` +
        "columns wraps in the wrong place",
      where: `${stop.session}/${stop.state}`,
      measured: { client: snapshot.cols, tmux: tmuxCols },
    });
  }

  if (Math.abs(snapshot.rows - tmuxRows) > 1) {
    findings.push({
      id: findingId("reflow", "rows", stop.session, device),
      severity: "major",
      detector: "reflow",
      detail:
        `the client fitted ${snapshot.rows} rows but tmux is rendering ` +
        `${tmuxRows} — the bottom of the pane is cut off or padded`,
      where: `${stop.session}/${stop.state}`,
      measured: { client: snapshot.rows, tmux: tmuxRows },
    });
  }

  return findings;
}
