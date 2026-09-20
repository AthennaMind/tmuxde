import { randomBytes } from "node:crypto";
import readline from "node:readline";
import kleur from "kleur";
import { renderAccessRequest } from "../access-prompt.js";
import { load as loadConfig } from "../config-store.js";
import * as serverState from "../server-state.js";
import { APPROVE_DECIDE_PATH, APPROVE_WAIT_PATH } from "../approve-control.js";

/**
 * Open an approval window on this machine.
 *
 * ## What this is for
 *
 * A machine running as a service — a systemd unit, a container, a box you last
 * touched over SSH — has nobody sitting at it, so a dashboard access request
 * hits `promptForAccess`, finds no TTY, and denies. That is correct: silence is
 * not consent. But it leaves a real user with an account, a registered machine,
 * and no way to admit a new phone to it.
 *
 * So: SSH in, run this, and for the next few minutes a request will be shown
 * *here* instead of denied. Then go and press the button in the browser.
 *
 * ## Why not a queue
 *
 * See the header of `approve-control.ts`. The short version: the browser's half
 * of the exchange is an ephemeral key in one tab's memory with a 120-second
 * broker TTL, so there is nothing durable to queue. The window persists; the
 * request cannot.
 *
 * ## Why it does not open its own tunnel
 *
 * The request arrives on the *daemon's* tunnel socket, and the broker routes by
 * device. A second registration from this process would take over that routing
 * and break every live session on the machine. This talks to the daemon over
 * loopback instead.
 */

export type ApproveOpts = {
  port: number;
  /** How long to stay available. */
  timeout: number;
  /** Keep the window open after the first decision. */
  keep: boolean;
};

type WaitResponse =
  | {
      type: "request";
      id: string;
      sas: string;
      deviceLabel: string;
      accountEmail: string;
    }
  | { type: "closed" };

export async function approve(opts: ApproveOpts): Promise<void> {
  const state = await serverState.read();
  if (!state) {
    console.error("");
    console.error(kleur.red("  No mtmux server is running here."));
    console.error(
      kleur.dim("  Start one with ") +
        kleur.bold("mtmux") +
        kleur.dim(", then run this again."),
    );
    console.error("");
    process.exitCode = 1;
    return;
  }

  /**
   * A LAN-only daemon has no broker requests to wait for, so refuse early
   * rather than sitting there looking useful. `--local` is an explicit choice
   * to never contact our servers, and an access request is something only our
   * servers can deliver.
   */
  if (state.mode === "local") {
    console.error("");
    console.error(kleur.red("  This server is running in local-only mode."));
    console.error(
      kleur.dim(
        "  Access requests arrive over the tunnel, so there is nothing to wait for.\n" +
          "  Restart without --local, or pair with a code instead.",
      ),
    );
    console.error("");
    process.exitCode = 1;
    return;
  }

  const cfg = await loadConfig();
  const port = opts.port || state.port;
  const sessionId = randomBytes(8).toString("hex");
  const minutes = Math.max(1, Math.round(opts.timeout));
  const deadline = Date.now() + minutes * 60_000;

  console.log("");
  console.log(
    kleur.bold(
      `  Ready to approve for ${minutes} minute${minutes === 1 ? "" : "s"}.`,
    ),
  );
  console.log(
    kleur.dim("  Open the dashboard and press ") +
      kleur.bold("Pair this device") +
      kleur.dim(" on this machine."),
  );
  console.log(kleur.dim("  Ctrl-C to stop waiting."));
  console.log("");

  for (;;) {
    if (Date.now() >= deadline) {
      console.log(kleur.dim("  Window closed. Nothing was approved."));
      console.log("");
      return;
    }

    let answer: WaitResponse;
    try {
      answer = await poll(port, cfg.token, sessionId, minutes, deadline);
    } catch (err) {
      if (err instanceof WindowTaken) {
        console.error(kleur.red(`  ${err.message}`));
        console.error("");
        process.exitCode = 1;
        return;
      }
      // A long-poll that ends because nothing arrived is the normal case, not
      // an error — go round again until the deadline.
      if (err instanceof PollExpired) continue;
      console.error(
        kleur.red("  Lost contact with the mtmux server on this machine."),
      );
      console.error("");
      process.exitCode = 1;
      return;
    }

    if (answer.type === "closed") {
      console.log(kleur.dim("  Window closed."));
      console.log("");
      return;
    }

    // Exactly what `mtmux start` shows in its own terminal, from the same
    // function, so the two paths cannot describe the same request differently.
    for (const line of renderAccessRequest(answer)) console.log(line);

    const approved = await ask();
    const landed = await decide(
      port,
      cfg.token,
      sessionId,
      answer.id,
      approved,
    );
    console.log(
      !landed
        ? kleur.dim("  · Too late — it was already answered elsewhere.\n")
        : approved
          ? kleur.green("  ✓ Approved.\n")
          : kleur.yellow("  ✗ Refused.\n"),
    );

    if (!opts.keep) return;
    console.log(kleur.dim("  Still waiting — Ctrl-C to stop."));
    console.log("");
  }
}

class WindowTaken extends Error {}
class PollExpired extends Error {}

async function poll(
  port: number,
  token: string,
  sessionId: string,
  minutes: number,
  deadline: number,
): Promise<WaitResponse> {
  // Bounded so the socket is not held open past the window, and so a daemon
  // that died is noticed rather than waited on forever.
  const budget = Math.min(30_000, Math.max(1_000, deadline - Date.now()));
  const res = await fetch(`http://127.0.0.1:${port}${APPROVE_WAIT_PATH}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ sessionId, minutes }),
    signal: AbortSignal.timeout(budget),
  }).catch((err: unknown) => {
    if (err instanceof Error && /timeout|abort/i.test(err.name + err.message)) {
      throw new PollExpired();
    }
    throw err;
  });

  if (res.status === 409) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new WindowTaken(
      body.error ?? "Another approval window is already open on this machine.",
    );
  }
  if (!res.ok) throw new Error(`wait failed: ${res.status}`);
  return (await res.json()) as WaitResponse;
}

async function decide(
  port: number,
  token: string,
  sessionId: string,
  id: string,
  approved: boolean,
): Promise<boolean> {
  const res = await fetch(`http://127.0.0.1:${port}${APPROVE_DECIDE_PATH}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ sessionId, id, approved }),
    signal: AbortSignal.timeout(5_000),
  }).catch(() => null);
  // The daemon times the offer out on its own, and a lost "no" is still a no.
  // Only a lost "yes" costs the user a retry, which is the right way for this
  // to fail.
  //
  // A 409 is not a lost answer, though — it is an answer that arrived after
  // the question was already settled, which now happens routinely: the same
  // request is put to any connected device at the same time, and whoever is
  // actually looking at a screen gets there first. Reporting it matters
  // because the alternative is this terminal printing "✓ Approved" for
  // something it did not approve.
  return res?.ok === true;
}

/**
 * The same question `promptForAccess` asks, with the same default.
 *
 * "Do these match?" rather than "is this correct?" — the six digits are not a
 * password and not secret. They are a comparison, and the only way the two
 * screens disagree is if something sat in the middle.
 */
async function ask(): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const answer = await new Promise<string>((resolve) => {
      rl.question(
        kleur.bold("  Matches what your browser shows?") + " [y/N] ",
        resolve,
      );
    });
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}
