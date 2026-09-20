import readline from "node:readline";
import kleur from "kleur";
import { formatSas } from "@repo/crypto";
import { displayLabel } from "@repo/protocol";

/**
 * The prompt a browser's access request raises on this machine.
 *
 * This is the strongest gate in the product, and it is deliberately the only
 * pairing path that has one. The rule is: demand approval exactly when the
 * requester cannot be presumed present at the machine.
 *
 *   `mtmux start` code/QR  — no prompt. You ran the command, you are standing
 *                            there, the code is fresh and short-lived. A
 *                            keypress here is pure friction at the one moment
 *                            the product should feel magical.
 *   dashboard request      — prompt. Nobody is necessarily at the machine.
 *
 * The six digits are not a password and are not secret. They are a comparison:
 * the browser shows the same number, and the only way the two disagree is if
 * something sat in the middle of the exchange. So the question asked is
 * "do these match?", never "is this code correct?".
 */

/** Long enough to walk to the machine; short enough to not sit forever. */
const PROMPT_TIMEOUT_MS = 110_000;

export type AccessPromptInput = {
  sas: string;
  deviceLabel: string;
  accountEmail: string;
};

export type AccessPromptResult =
  | { approved: true }
  | { approved: false; reason: "refused" | "no-tty" | "timeout" };

export type PromptDeps = {
  input?: NodeJS.ReadableStream & { isTTY?: boolean };
  output?: NodeJS.WritableStream;
  timeoutMs?: number;
  /**
   * Another channel answered — close the prompt and give stdin back.
   *
   * Not a decision. An aborted prompt returns `no-tty`, which the race reads
   * as "could not ask", so an abort can never be mistaken for a refusal.
   */
  signal?: AbortSignal;
};

/**
 * Render the request. Exported so a test can assert what a human is shown
 * without driving a terminal.
 */
export function renderAccessRequest(req: AccessPromptInput): string[] {
  return [
    "",
    kleur.bold("  A browser wants to pair with this machine"),
    "",
    `    ${kleur.dim("Device ")}  ${displayLabel(req.deviceLabel, "unknown device")}`,
    `    ${kleur.dim("Account")}  ${displayLabel(req.accountEmail, "unknown account")}`,
    `    ${kleur.dim("Code   ")}  ${kleur.bold(formatSas(req.sas))}`,
    "",
  ];
}

/**
 * Who gets asked — and why it is a race rather than a list.
 *
 * There are now two *independent* places a human might be standing: at the
 * machine, and in the app on a phone that is already connected. Neither is the
 * fallback for the other. The person who runs `mtmux start` in a terminal and
 * the person holding the phone are, very often, the same person — in the same
 * minute, in different rooms — and the product cannot know which room.
 *
 * So both are asked at once and the first real answer wins:
 *
 *   **In-app**   — every connected full-grant browser gets a dialog with the
 *                  device, the account and the six digits to compare. It can
 *                  also *abstain* (`null`): nobody is connected, or the last
 *                  one closed the tab with the question still up. Abstaining
 *                  hands the decision back; it never makes it.
 *   **Local**    — the chain this function always had: `mtmux approve` if a
 *                  window is open, else the TTY prompt, else park the request
 *                  and say so in the terminal.
 *
 * Two rules keep the race honest, and both are the kind of thing that is
 * obvious once stated and invisible until it bites:
 *
 * 1. **`no-tty` is not an answer.** A daemonised `mtmux start` with no
 *    approval window resolves the local chain *instantly* with "I could not
 *    ask", which would beat a human every time and deny a request that was
 *    sitting on their screen. It is held as a fallback and only used once the
 *    in-app channel has also declined to answer.
 * 2. **Whoever loses is told to stop.** The winner aborts the other channel,
 *    which closes the readline prompt (so the terminal is usable again and
 *    stdin is released) and frees the parked offer slot. Without it, approving
 *    on a phone left a dead "[y/N]" swallowing keystrokes on the machine.
 *
 * Silence is still a denial on every channel. Racing changes who gets asked,
 * never what an unanswered question means. And everything downstream of the
 * decision is untouched, so a pairing approved on a phone is identical to one
 * approved at the keyboard.
 */
export async function decideAccess(
  req: AccessPromptInput,
  deps: {
    /**
     * Ask every connected browser. `null` abstains — see above.
     *
     * Optional so the CLI degrades to the old behaviour against a relay bundle
     * that predates it, rather than crashing on boot.
     */
    ask?: (
      req: AccessPromptInput,
      signal: AbortSignal,
    ) => Promise<boolean | null>;
    /** Returns null when no approval window is open. */
    offer?: (req: AccessPromptInput) => Promise<boolean | null>;
    /** Hold the request open with nobody polling. Returns false on timeout. */
    park?: (req: AccessPromptInput, signal: AbortSignal) => Promise<boolean>;
    /** Called once, when a request is parked, so the terminal can say so. */
    onParked?: (req: AccessPromptInput) => void;
    prompt?: (
      req: AccessPromptInput,
      signal: AbortSignal,
    ) => Promise<AccessPromptResult>;
  } = {},
): Promise<AccessPromptResult> {
  const controller = new AbortController();
  const { signal } = controller;

  const local = localChain(req, deps, signal);
  // `ask` is invoked eagerly, before anything is awaited, so the dialog is on
  // the phone in the same tick the terminal prints its prompt.
  const inApp = deps.ask
    ? deps.ask(req, signal).catch(() => null)
    : Promise.resolve<boolean | null>(null);

  try {
    return await firstAnswer(inApp, local);
  } finally {
    // Whatever did not win stops now: the prompt closes, the parked offer slot
    // is freed, and the dialog on any other phone is dismissed.
    controller.abort();
  }
}

/**
 * Settle on the first channel that actually decides.
 *
 * `no-tty` from the local chain is held rather than returned — rule 1 above.
 * When both channels decline, the held value is the answer, which preserves
 * the old behaviour exactly for a machine with nothing connected.
 */
function firstAnswer(
  inApp: Promise<boolean | null>,
  local: Promise<AccessPromptResult>,
): Promise<AccessPromptResult> {
  return new Promise<AccessPromptResult>((resolve) => {
    let settled = false;
    let open = 2;
    let held: AccessPromptResult | null = null;

    const answer = (result: AccessPromptResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const abstain = (): void => {
      open -= 1;
      // Both channels passed. Whatever the local one could not do is the
      // honest answer; there is nothing else left to ask.
      if (open === 0 && !settled) {
        answer(held ?? { approved: false, reason: "no-tty" });
      }
    };

    void inApp.then((value) => {
      if (value === true) answer({ approved: true });
      else if (value === false) answer({ approved: false, reason: "refused" });
      else abstain();
    });

    void local.then(
      (result) => {
        if (result.approved || result.reason !== "no-tty") answer(result);
        else {
          held = result;
          abstain();
        }
      },
      // A channel that throws has not answered. It must not be able to deny.
      () => abstain(),
    );
  });
}

/**
 * The machine's own channel, unchanged in order and meaning.
 *
 *   1. Somebody ran `mtmux approve` and is waiting → they decide.
 *   2. There is a TTY → the prompt.
 *   3. Neither, and we can park → hold it for the offer window, tell the
 *      terminal, and let them run `mtmux approve` in another shell.
 *   4. Neither, and we cannot → `no-tty`, which the race treats as "could not
 *      ask" rather than as a refusal.
 *
 * `offer` returning **null** means "nobody is waiting", which is emphatically
 * not a refusal. Collapsing the two would mean a machine with an idle approval
 * window silently stopped prompting in its own terminal — a regression that
 * would look, from the outside, exactly like the feature working.
 */
async function localChain(
  req: AccessPromptInput,
  deps: {
    offer?: (req: AccessPromptInput) => Promise<boolean | null>;
    park?: (req: AccessPromptInput, signal: AbortSignal) => Promise<boolean>;
    onParked?: (req: AccessPromptInput) => void;
    prompt?: (
      req: AccessPromptInput,
      signal: AbortSignal,
    ) => Promise<AccessPromptResult>;
  },
  signal: AbortSignal,
): Promise<AccessPromptResult> {
  const offered = deps.offer ? await deps.offer(req) : null;
  if (offered !== null) {
    return offered
      ? { approved: true }
      : { approved: false, reason: "refused" };
  }
  if (signal.aborted) return { approved: false, reason: "no-tty" };

  const ask = deps.prompt ?? ((r, s) => promptForAccess(r, { signal: s }));
  const asked = await ask(req, signal);
  // Anything the prompt could actually decide is final. Only `no-tty` — which
  // means it could not ask at all — falls through to parking.
  if (asked.approved || asked.reason !== "no-tty") return asked;
  if (!deps.park || signal.aborted) return asked;

  deps.onParked?.(req);
  const approved = await deps.park(req, signal);
  // A parked request nobody answered is a timeout, not a refusal — and the
  // browser offers a different way out for each.
  return approved ? { approved: true } : { approved: false, reason: "timeout" };
}

export async function promptForAccess(
  req: AccessPromptInput,
  deps: PromptDeps = {},
): Promise<AccessPromptResult> {
  const input = deps.input ?? process.stdin;
  const output = deps.output ?? process.stdout;

  if (!input.isTTY) return { approved: false, reason: "no-tty" };

  for (const line of renderAccessRequest(req)) {
    output.write(`${line}\n`);
  }

  const rl = readline.createInterface({ input, output });
  let aborted = false;
  let onAbort: (() => void) | null = null;
  try {
    const answer = await new Promise<string | null>((resolve) => {
      const timer = setTimeout(
        () => resolve(null),
        deps.timeoutMs ?? PROMPT_TIMEOUT_MS,
      );
      timer.unref?.();
      if (deps.signal) {
        onAbort = () => {
          aborted = true;
          clearTimeout(timer);
          // Closing the interface is what releases stdin. Without it the
          // machine sat at a dead "[y/N]" eating keystrokes after the question
          // had already been answered on a phone.
          rl.close();
          resolve(null);
        };
        if (deps.signal.aborted) onAbort();
        else deps.signal.addEventListener("abort", onAbort);
      }
      rl.question(
        kleur.bold("  Matches what your browser shows?") + " [y/N] ",
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
      );
    });

    if (aborted) {
      output.write(kleur.dim("  · Answered elsewhere.\n"));
      return { approved: false, reason: "no-tty" };
    }

    // Anything that is not an explicit yes — including a timeout, an empty
    // line, or EOF — is a no. Defaulting the other way would make walking away
    // from the keyboard an approval.
    const approved = /^y(es)?$/i.test((answer ?? "").trim());
    output.write(
      approved
        ? kleur.green("  ✓ Approved.\n")
        : kleur.yellow("  ✗ Refused.\n"),
    );
    return approved
      ? { approved: true }
      : { approved: false, reason: "refused" };
  } finally {
    if (deps.signal && onAbort)
      deps.signal.removeEventListener("abort", onAbort);
    rl.close();
  }
}

/**
 * A device that paired before is coming back, and the policy says ask.
 *
 * Deliberately not the same question as `promptForAccess`. There is no SAS to
 * compare here: the device already proved itself cryptographically — its key
 * schedule is what opened the frame — so nothing is being verified. What is
 * being asked is a policy question, "let this one back in?", and dressing it up
 * with a six-digit code nobody can check would teach people to ignore the
 * codes that do matter.
 *
 * No TTY means refuse. Someone who set `reconnectPolicy: confirm` asked for a
 * human in the loop, and silently admitting the device because nobody could be
 * asked would be the setting quietly not applying — the worst outcome for a
 * security control. The refusal says how to change it.
 */
export type ReturningDevice = { label: string; pairedAt?: number };

export function renderReturningDevice(device: ReturningDevice): string[] {
  return [
    "",
    kleur.bold("  A device you paired earlier is reconnecting"),
    "",
    `    ${kleur.dim("Device")}  ${device.label || "unknown device"}`,
    ...(device.pairedAt
      ? [
          `    ${kleur.dim("Paired")}  ${new Date(device.pairedAt).toLocaleString()}`,
        ]
      : []),
    "",
  ];
}

export async function promptForReturningDevice(
  device: ReturningDevice,
  deps: PromptDeps = {},
): Promise<AccessPromptResult> {
  const input = deps.input ?? process.stdin;
  const output = deps.output ?? process.stdout;

  if (!input.isTTY) return { approved: false, reason: "no-tty" };

  for (const line of renderReturningDevice(device)) {
    output.write(`${line}\n`);
  }

  const rl = readline.createInterface({ input, output });
  try {
    const answer = await new Promise<string | null>((resolve) => {
      const timer = setTimeout(
        () => resolve(null),
        deps.timeoutMs ?? PROMPT_TIMEOUT_MS,
      );
      timer.unref?.();
      rl.question(kleur.bold("  Let it reconnect?") + " [y/N] ", (value) => {
        clearTimeout(timer);
        resolve(value);
      });
    });
    if (answer === null) return { approved: false, reason: "timeout" };
    return /^y(es)?$/i.test(answer.trim())
      ? { approved: true }
      : { approved: false, reason: "refused" };
  } finally {
    rl.close();
  }
}
