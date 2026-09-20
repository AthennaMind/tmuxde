import { describe, expect, it, vi } from "vitest";
import { PassThrough } from "node:stream";

import {
  decideAccess,
  promptForAccess,
  renderAccessRequest,
  promptForReturningDevice,
  renderReturningDevice,
  type AccessPromptInput,
} from "./access-prompt.js";

const REQUEST: AccessPromptInput = {
  sas: "482173",
  deviceLabel: "Chrome on macOS",
  accountEmail: "dp@example.com",
};

function tty(answer: string) {
  const input = new PassThrough() as PassThrough & { isTTY?: boolean };
  input.isTTY = true;
  const output = new PassThrough();
  output.resume();
  // The prompt writes its question, then waits for a line.
  setTimeout(() => input.write(`${answer}\n`), 5);
  return { input, output };
}

describe("renderAccessRequest", () => {
  it("shows the digits grouped, so two people can read them to each other", () => {
    const text = renderAccessRequest(REQUEST).join("\n");
    expect(text).toContain("482 173");
    expect(text).toContain("Chrome on macOS");
    expect(text).toContain("dp@example.com");
  });
});

/**
 * The precedence the three-way branch in `onAccessRequest` rests on.
 *
 * The load-bearing case is the first one: `offer` returning **null** means
 * nobody is waiting, and it must not be confusable with a refusal. Collapse the
 * two and a machine with an idle approval window silently stops prompting in
 * its own terminal — which from the outside looks exactly like the feature
 * working.
 */
/**
 * The in-app channel, raced against the machine's own.
 *
 * Two independent humans may be standing in two places, and the product cannot
 * know which. Every case below is about who is allowed to answer for whom.
 */
describe("decideAccess: the in-app channel", () => {
  const noTty = async () => ({ approved: false, reason: "no-tty" }) as const;
  /** Never settles, like a dialog sitting unanswered on a phone. */
  const pending = () => new Promise<boolean | null>(() => {});

  it("lets the app approve while the machine has nobody to ask", async () => {
    // The headline case: `mtmux start` under systemd, no approval window, and
    // a phone in your hand. Before the race this was denied `no-tty` in the
    // same millisecond, with the dialog still on screen.
    const result = await decideAccess(REQUEST, {
      ask: async () => true,
      prompt: noTty,
    });
    expect(result).toEqual({ approved: true });
  });

  it("does not let `no-tty` beat a human who is still deciding", async () => {
    // Rule 1. The local chain answers instantly and the phone answers in a
    // second; the instant answer is "I could not ask", which must never win.
    let answer: (v: boolean | null) => void = () => {};
    const result = decideAccess(REQUEST, {
      ask: () => new Promise<boolean | null>((r) => (answer = r)),
      prompt: noTty,
    });
    await Promise.resolve();
    answer(true);
    await expect(result).resolves.toEqual({ approved: true });
  });

  it("falls back to `no-tty` once the app abstains too", async () => {
    // Nothing connected. The old behaviour, exactly, and the reason `held` is
    // kept rather than discarded.
    const result = await decideAccess(REQUEST, {
      ask: async () => null,
      prompt: noTty,
    });
    expect(result).toEqual({ approved: false, reason: "no-tty" });
  });

  it("carries an in-app denial through as a refusal", async () => {
    const result = await decideAccess(REQUEST, {
      ask: async () => false,
      prompt: pending as unknown as () => Promise<never>,
    });
    expect(result).toEqual({ approved: false, reason: "refused" });
  });

  it("lets the machine win when it answers first", async () => {
    // The app abstaining must not stop the TTY, and a TTY decision is final.
    const result = await decideAccess(REQUEST, {
      ask: () => pending(),
      prompt: async () => ({ approved: true }) as const,
    });
    expect(result).toEqual({ approved: true });
  });

  it("tells the loser to stop", async () => {
    // Rule 2. Without the abort, approving on a phone left a dead "[y/N]" on
    // the machine eating keystrokes, and the parked offer slot held for the
    // full timeout — refusing the *next* device for a question already
    // answered.
    let aborted = false;
    const result = await decideAccess(REQUEST, {
      ask: async () => true,
      prompt: (_req, signal) => {
        signal.addEventListener("abort", () => (aborted = true));
        return pending() as Promise<never>;
      },
    });
    expect(result).toEqual({ approved: true });
    expect(aborted).toBe(true);
  });

  it("does not let a broken app channel deny anything", async () => {
    // A throw is not an answer. The whole point of the fallback is that a bug
    // in the dialog cannot become a silent refusal.
    const result = await decideAccess(REQUEST, {
      ask: async () => {
        throw new Error("socket died");
      },
      prompt: async () => ({ approved: true }) as const,
    });
    expect(result).toEqual({ approved: true });
  });

  it("still denies when neither channel ever answers", async () => {
    // Silence is not consent, on either channel or both at once.
    const result = await decideAccess(REQUEST, {
      ask: async () => null,
      prompt: noTty,
      park: async () => false,
    });
    expect(result).toEqual({ approved: false, reason: "timeout" });
  });

  it("asks the app even when an approval window is open", async () => {
    // `mtmux approve` and the phone are peers, not a fallback chain: whoever
    // is actually looking at a screen answers.
    const result = await decideAccess(REQUEST, {
      ask: async () => true,
      offer: () => new Promise<boolean | null>(() => {}),
    });
    expect(result).toEqual({ approved: true });
  });
});

describe("decideAccess", () => {
  it("prompts when no approval window is open", async () => {
    const prompt = vi.fn(async () => ({ approved: true }) as const);
    const result = await decideAccess(REQUEST, {
      offer: async () => null,
      prompt,
    });

    expect(prompt).toHaveBeenCalledOnce();
    expect(result).toEqual({ approved: true });
  });

  it("prompts when there is no approval window at all", async () => {
    const prompt = vi.fn(async () => ({ approved: true }) as const);
    await decideAccess(REQUEST, { prompt });
    expect(prompt).toHaveBeenCalledOnce();
  });

  it("lets a waiting approver decide, and never asks the TTY as well", async () => {
    const prompt = vi.fn(async () => ({ approved: true }) as const);
    const result = await decideAccess(REQUEST, {
      offer: async () => true,
      prompt,
    });

    expect(result).toEqual({ approved: true });
    expect(prompt).not.toHaveBeenCalled();
  });

  it("takes a waiting approver's refusal as final", async () => {
    const prompt = vi.fn(async () => ({ approved: true }) as const);
    const result = await decideAccess(REQUEST, {
      offer: async () => false,
      prompt,
    });

    // Emphatically not a fall-through to the prompt: a human already said no,
    // and asking a second time until someone says yes is not a gate.
    expect(result).toEqual({ approved: false, reason: "refused" });
    expect(prompt).not.toHaveBeenCalled();
  });

  describe("with no TTY to ask", () => {
    const noTty = async () => ({ approved: false, reason: "no-tty" }) as const;

    it("parks the request instead of denying instantly", async () => {
      // The case this exists for. `mtmux start` under systemd, `nohup` or a
      // detached pane has no TTY, so pressing "Pair this device" was denied in
      // the same millisecond it was asked, while the user sat watching.
      const onParked = vi.fn();
      const park = vi.fn(async () => true);
      const result = await decideAccess(REQUEST, {
        prompt: noTty,
        park,
        onParked,
      });

      expect(onParked).toHaveBeenCalledOnce();
      expect(park).toHaveBeenCalledOnce();
      expect(result).toEqual({ approved: true });
    });

    it("reports a timeout, which is not a refusal", async () => {
      // The browser offers a different way out for each: "ask again" for a
      // timeout, and emphatically not for a refusal.
      const result = await decideAccess(REQUEST, {
        prompt: noTty,
        park: async () => false,
      });
      expect(result).toEqual({ approved: false, reason: "timeout" });
    });

    it("still denies when there is nowhere to park it", async () => {
      const result = await decideAccess(REQUEST, { prompt: noTty });
      expect(result).toEqual({ approved: false, reason: "no-tty" });
    });

    it("never parks a decision the prompt could actually make", async () => {
      // A human at the keyboard saying no is final. Parking after a refusal
      // would be asking again until someone says yes, which is not a gate.
      const park = vi.fn(async () => true);
      const result = await decideAccess(REQUEST, {
        prompt: async () => ({ approved: false, reason: "refused" }) as const,
        park,
      });
      expect(park).not.toHaveBeenCalled();
      expect(result).toEqual({ approved: false, reason: "refused" });
    });

    it("never parks when an approver already answered", async () => {
      const park = vi.fn(async () => true);
      const result = await decideAccess(REQUEST, {
        offer: async () => false,
        prompt: noTty,
        park,
      });
      expect(park).not.toHaveBeenCalled();
      expect(result).toEqual({ approved: false, reason: "refused" });
    });
  });
});

describe("promptForAccess", () => {
  it("denies no-tty rather than waiting or auto-approving", async () => {
    const input = new PassThrough() as PassThrough & { isTTY?: boolean };
    input.isTTY = false;
    const result = await promptForAccess(REQUEST, { input });
    expect(result).toEqual({ approved: false, reason: "no-tty" });
  });

  it("approves on an explicit yes", async () => {
    const result = await promptForAccess(REQUEST, tty("y"));
    expect(result).toEqual({ approved: true });
  });

  it("refuses on anything else, including an empty line", async () => {
    expect(await promptForAccess(REQUEST, tty(""))).toEqual({
      approved: false,
      reason: "refused",
    });
    expect(await promptForAccess(REQUEST, tty("sure"))).toEqual({
      approved: false,
      reason: "refused",
    });
  });

  it("refuses on a timeout, so walking away is not consent", async () => {
    const input = new PassThrough() as PassThrough & { isTTY?: boolean };
    input.isTTY = true;
    const output = new PassThrough();
    output.resume();

    const result = await promptForAccess(REQUEST, {
      input,
      output,
      timeoutMs: 20,
    });
    expect(result).toEqual({ approved: false, reason: "refused" });
  });
});

/**
 * The reconnect prompt, which is a different question from the access prompt.
 *
 * The device already proved itself — its key schedule is what decrypted the
 * frame — so nothing is being verified here. What is being asked is policy:
 * "let this one back in?". Showing a six-digit code nobody can check would
 * teach people to wave through the codes that do matter.
 */
describe("promptForReturningDevice", () => {
  const DEVICE = { label: "iPhone · Safari", pairedAt: 1_700_000_000_000 };

  it("shows no comparison code, because there is nothing to compare", () => {
    const text = renderReturningDevice(DEVICE).join("\n");
    expect(text).toContain("iPhone · Safari");
    expect(text).not.toMatch(/\d{3} \d{3}/);
  });

  it("names when the device was paired, so 'do I know this?' is answerable", () => {
    const text = renderReturningDevice(DEVICE).join("\n");
    expect(text).toContain("Paired");
  });

  it("omits the paired date when there isn't one", () => {
    const text = renderReturningDevice({ label: "iPhone" }).join("\n");
    expect(text).not.toContain("Paired");
  });

  it("admits on y", async () => {
    const { input, output } = tty("y");
    await expect(
      promptForReturningDevice(DEVICE, { input, output }),
    ).resolves.toEqual({ approved: true });
  });

  it("refuses on anything else, including a bare Enter", async () => {
    for (const answer of ["", "n", "no", "maybe"]) {
      const { input, output } = tty(answer);
      await expect(
        promptForReturningDevice(DEVICE, { input, output }),
      ).resolves.toEqual({ approved: false, reason: "refused" });
    }
  });

  it("refuses with no TTY rather than admitting silently", async () => {
    // Admitting here would be the setting quietly not applying, which is the
    // worst outcome available for a control someone deliberately turned on.
    const input = new PassThrough() as PassThrough & { isTTY?: boolean };
    input.isTTY = false;
    await expect(
      promptForReturningDevice(DEVICE, { input, output: new PassThrough() }),
    ).resolves.toEqual({ approved: false, reason: "no-tty" });
  });

  it("times out rather than waiting forever", async () => {
    const input = new PassThrough() as PassThrough & { isTTY?: boolean };
    input.isTTY = true;
    const output = new PassThrough();
    output.resume();
    await expect(
      promptForReturningDevice(DEVICE, { input, output, timeoutMs: 10 }),
    ).resolves.toEqual({ approved: false, reason: "timeout" });
  });
});
