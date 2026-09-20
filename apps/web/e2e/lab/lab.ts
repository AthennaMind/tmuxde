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
  opts: { escapes?: boolean; lines?: number; join?: boolean } = {},
): string {
  const args = ["capture-pane", "-t", target, "-p"];
  if (opts.escapes) args.push("-e");
  // Opt-in, and off by default, because the default is what `fidelity.ts`
  // needs. Joining is right only when the question is "does this text exist",
  // and wrong whenever it is "is this laid out correctly".
  if (opts.join) args.push("-J");
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

/**
 * Stop whatever a profile session is producing, and wait for it to settle.
 *
 * A moving target cannot be diffed. The fidelity check under load therefore
 * has two halves: produce the load, then stop it and compare — because "the
 * client kept up" and "the client ended up with the right bytes" are different
 * claims and the second is the one that matters after a burst.
 *
 * `C-c` rather than killing the pane: `seed.sh` hands every profile over to an
 * interactive shell when it finishes, so interrupting leaves a live, typable
 * pane exactly as the profile's normal end would.
 */
export function quiesce(session: string): void {
  tmux(["send-keys", "-t", session, "C-c"]);
  let last = "";
  for (let i = 0; i < 40; i++) {
    const now = String(outputProgress(session));
    if (now === last) return;
    last = now;
    // Busy-wait: this runs in the test process, not the page, and 100ms of a
    // synchronous sleep is cheaper than threading a promise through a
    // synchronous tmux helper used everywhere else.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
}

/** Start a profile generator again in a session that was quiesced. */
export function restartProfile(session: string, profile: string): void {
  tmux(["send-keys", "-t", session, `python3 /lab/gen.py ${profile}`, "Enter"]);
}

/**
 * A monotonic measure of how much a session has produced.
 *
 * **Not `#{history_size}`**, which is what this was and which is capped at the
 * session's `history-limit`. A firehose fills 10 000 lines in two seconds and
 * then reports the same number forever — so "the count stopped changing" read
 * as "output stopped" the moment the buffer was full, and every check built on
 * it silently measured nothing. `quiesce()` returned immediately; a test that
 * timed how long Ctrl-C took to land answered in milliseconds without the
 * keystroke having arrived.
 *
 * The generators number their lines, so the last number on screen is a real,
 * uncapped position. Sessions that print nothing numbered fall back to the
 * pane's dimensions plus its cursor, which still moves when anything is
 * written and is stable when nothing is.
 */
export function outputProgress(session: string): number {
  const visible = capturePane(session);
  const numbered = visible.match(/\[(\d{4,})\]/g);
  if (numbered && numbered.length > 0) {
    return Number(numbered[numbered.length - 1]!.replace(/\D/g, ""));
  }
  const counted = visible.match(/\b(\d{4,})\b/g);
  if (counted && counted.length > 0) {
    return Number(counted[counted.length - 1]);
  }
  return Number(tmuxFormat(session, "#{history_size}"));
}

/**
 * The viewport as *logical* lines, with the terminal's own wrapping undone.
 *
 * A row is not a line. At a phone's 47 columns `echo mtmux-lab-alive-mu9dwiof`
 * occupies two rows, and no single row contains it — so a helper that searched
 * the rows for what it had just typed timed out against a terminal that had
 * rendered every character correctly, on exactly the two projects narrow enough
 * to wrap. It read as "the keystrokes never arrived".
 *
 * Joined on `isWrapped`, which xterm sets on the continuation row, rather than
 * by concatenating everything: joining blindly would merge two genuinely
 * separate lines and hand back a match that was never on screen.
 *
 * Deliberately not used by `fidelity.ts`. That diffs row-for-row against
 * `capture-pane` *without* `-J`, because a line the client re-wrapped somewhere
 * tmux did not is precisely the defect it exists to catch. Unwrapping is right
 * for "did this text appear" and wrong for "is this laid out correctly".
 */
export function logicalLines(snap: {
  lines: string[];
  wrapped: boolean[];
}): string[] {
  const out: string[] = [];
  snap.lines.forEach((line, i) => {
    if (i > 0 && snap.wrapped[i]) out[out.length - 1] += line;
    else out.push(line);
  });
  return out;
}
