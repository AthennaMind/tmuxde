import { execFileSync } from "node:child_process";

/**
 * The lab container, as seen from a spec.
 *
 * Everything here shells out to `docker exec`. That is not a shortcut around a
 * nicer API — it is the only way to see the *other* side of the rendering.
 * tmux composites server-side: the browser receives one linear ANSI stream of
 * tmux's own output, so the only ground truth for "what should be on screen"
 * is tmux's own `capture-pane`, and the only place to ask is inside the
 * container. A detector that compares xterm's buffer to another DOM reading of
 * xterm's buffer proves nothing.
 */

const CONTAINER = process.env.LAB_CONTAINER ?? "mtmux-lab-lab-1";
const SOCKET = process.env.LAB_SOCKET ?? "/run/lab/tmux.sock";

/** Every session `docker/tmux-lab/seed.sh` creates, and what each one is for. */
export const LAB_SESSIONS = [
  "idle",
  "drip",
  "colors",
  "unicode",
  "progress",
  "longlines",
  "ctrlseq",
  "garbage",
  "altscreen",
  "many-windows",
  "many-panes",
  "firehose",
  "scrollback",
] as const;

export type LabSession = (typeof LAB_SESSIONS)[number];

/** The token the lab's relay is configured with. Kept in step with `lab.mjs`. */
export const LAB_TOKEN =
  process.env.E2E_RELAY_TOKEN ?? "mtmux-lab-token-not-for-production";

function docker(args: string[]): string {
  return execFileSync("docker", args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

/**
 * Run a command inside the lab.
 *
 * Throws with an actionable message when the container is not there, because
 * the alternative — a spec timing out on a terminal that never attaches — sends
 * whoever is reading the failure looking in the browser for a problem that is
 * in Docker.
 */
export function inLab(args: string[]): string {
  try {
    return docker(["exec", CONTAINER, ...args]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/No such container|is not running/i.test(message)) {
      throw new Error(
        `the lab container (${CONTAINER}) is not running.\n` +
          "Start it with:  node scripts/lab.mjs up\n" +
          "Or run the suite through:  pnpm --filter @app/web e2e:lab",
      );
    }
    throw err;
  }
}

export function tmux(args: string[]): string {
  return inLab(["tmux", "-S", SOCKET, ...args]);
}

/**
 * tmux's own rendering of a pane — the ground truth every fidelity check diffs
 * against.
 *
 * `-J` is deliberately **off**. Joining wrapped lines would hide precisely the
 * defect this is here to catch: a line tmux wrapped at column N that the client
 * re-wrapped somewhere else.
 */
export function capturePane(
  target: string,
  opts: { escapes?: boolean; lines?: number } = {},
): string {
  const args = ["capture-pane", "-t", target, "-p"];
  if (opts.escapes) args.push("-e");
  if (opts.lines !== undefined) args.push("-S", `-${opts.lines}`);
  return tmux(args);
}

/** A tmux format string evaluated against a target, e.g. `#{history_size}`. */
export function tmuxFormat(target: string, format: string): string {
  return tmux(["display-message", "-p", "-t", target, format]).trim();
}

/** The size tmux believes a session's active window is, as `[cols, rows]`. */
export function tmuxSize(session: string): [number, number] {
  const raw = tmuxFormat(session, "#{window_width}x#{window_height}");
  const [cols, rows] = raw.split("x").map((n) => Number(n));
  return [cols ?? 0, rows ?? 0];
}

/** Re-seed between specs that mutate the population. Seconds, not a restart. */
export function resetLab(): void {
  inLab(["/lab/seed.sh", "reset"]);
}

/**
 * Leave copy mode, if the session is in it.
 *
 * The lab is a long-lived server and specs share it, so a test that scrolls
 * leaves the pane in copy mode for whatever runs next. The first version of
 * the scroll test asserted `pane_in_mode == 0` as a precondition and failed on
 * four projects out of five — not because anything was broken, but because the
 * fifth had already passed.
 *
 * Restoring the precondition is the right fix rather than dropping the
 * assertion: "the drag put tmux into copy mode" only means something if tmux
 * was not already there.
 */
export function exitCopyMode(session: string): void {
  if (tmuxFormat(session, "#{pane_in_mode}") === "0") return;
  tmux(["send-keys", "-t", session, "-X", "cancel"]);
}
