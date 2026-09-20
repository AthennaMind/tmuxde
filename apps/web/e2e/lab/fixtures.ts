import {
  test as base,
  expect,
  type Page,
  type Locator,
} from "@playwright/test";
import type { TerminalSnapshot } from "@/components/terminal/terminal-handle";
import { LAB_TOKEN, capturePane, tmuxSize, type LabSession } from "./lab";

/**
 * The lab fixture: a browser attached to a real tmux session in the container.
 *
 * ## Getting in without a QR
 *
 * The terminal layout's auth guard bounces to `/start` unless a token is
 * present, so the first thing every spec needs is to be signed in. There is
 * nothing to invent here — `e2e/mobile-command-bar.spec.ts` already seeds
 * `mtmux-token` into `localStorage`, and this is that pattern with the lab's
 * own token, which the relay in the container is configured with.
 *
 * That is the one sanctioned `localStorage` use in CLAUDE.md invariant 3 (the
 * self-hosted relay bearer token), not an exception to it. No session key goes
 * near it; the self-hosted path has no session keys.
 */

/** Long enough for a cold `next dev` compile of the terminal route. */
const ATTACH_TIMEOUT = 45_000;

export interface LabTerminal {
  /** The terminal's own element — `role="group"`, labelled with the session. */
  readonly root: Locator;
  /** The gesture surface wrapping it, which is what touch events go to. */
  readonly surface: Locator;
  /** Read what is on screen, straight out of xterm's buffer. */
  snapshot(): Promise<TerminalSnapshot>;
  /** Wait until the rendered viewport matches, and return the snapshot. */
  waitFor(
    predicate: (snap: TerminalSnapshot) => boolean,
    message: string,
    timeout?: number,
  ): Promise<TerminalSnapshot>;
  /** Put the keyboard where a tap would: on xterm's own hidden textarea. */
  focus(): Promise<void>;
  /** Type into the session and wait for tmux to echo it back. */
  type(text: string): Promise<void>;
  /** tmux's own rendering of the same pane — the ground truth. */
  capture(opts?: { escapes?: boolean; lines?: number }): string;
  /** The size tmux believes this session is, as `[cols, rows]`. */
  tmuxSize(): [number, number];
}

export interface LabFixture {
  /** Sign in and attach to a seeded session. Resolves once output is flowing. */
  open(session: LabSession): Promise<LabTerminal>;
  /** Console errors, page errors and failed requests seen so far, in order. */
  readonly problems: string[];
}

export const test = base.extend<{ lab: LabFixture }>({
  /*
   * The second argument is Playwright's `use`, renamed.
   *
   * `react-hooks/rules-of-hooks` sees a call to something named `use` inside a
   * function whose name is neither a component nor a hook and fails the lint —
   * React 19 has a real `use()` and the rule cannot tell them apart. Renaming
   * the parameter is the whole fix; nothing about the fixture changes.
   */
  lab: async ({ page }, provide) => {
    const problems: string[] = [];

    /*
     * Collected for every spec, not only the ones that ask.
     *
     * `console.ts` turns this into an assertion, but the collection has to
     * start before the first navigation or the errors thrown during hydration
     * — the ones most worth catching — have already happened.
     */
    page.on("console", (msg) => {
      if (msg.type() === "error") problems.push(`console.error: ${msg.text()}`);
      if (msg.type() === "warning" && /^Warning:/.test(msg.text())) {
        problems.push(`react warning: ${msg.text()}`);
      }
    });
    page.on("pageerror", (err) => problems.push(`pageerror: ${err.message}`));
    page.on("requestfailed", (req) => {
      // Aborts are routine: a navigation cancels in-flight requests, and the
      // HMR socket is torn down on every route change under `next dev`.
      const failure = req.failure()?.errorText ?? "";
      if (/ERR_ABORTED/.test(failure)) return;
      problems.push(`requestfailed: ${req.url()} — ${failure}`);
    });

    const lab: LabFixture = {
      problems,
      async open(session) {
        await page.addInitScript(
          ([token, name]) => {
            localStorage.setItem("mtmux-token", token!);
            localStorage.setItem("mtmux-last-session", name!);
            // The first-run checklist covers the terminal on a phone, and a
            // tap-target sweep would measure its buttons instead of the ones
            // under test. Dismissed rather than closed, so no spec depends on
            // clicking it away first.
            localStorage.setItem("mtmux-onboarding-dismissed", "1");
          },
          [LAB_TOKEN, session] as const,
        );
        await page.goto("/");

        const root = page.getByRole("group", {
          name: `Terminal, session ${session}`,
        });
        await expect(
          root,
          `the terminal never attached to "${session}" — is the lab running?`,
        ).toBeVisible({ timeout: ATTACH_TIMEOUT });

        const terminal = makeTerminal(page, root, session);

        /*
         * Wait for *content*, not for the element.
         *
         * The container is in the DOM before the socket is up, before the
         * attach is acknowledged and before tmux has replayed the capture. A
         * spec that starts asserting at "visible" is asserting against an
         * empty grid, which is how a suite ends up full of retries.
         *
         * `idle` is the one session with legitimately nothing but a prompt, so
         * the predicate is "any non-blank row", not "some known text".
         */
        await terminal.waitFor(
          (snap) => snap.lines.some((l) => l.trim().length > 0),
          `"${session}" attached but never rendered anything`,
          ATTACH_TIMEOUT,
        );

        return terminal;
      },
    };

    await provide(lab);
  },
});

function makeTerminal(page: Page, root: Locator, session: string): LabTerminal {
  const snapshot = () =>
    page.evaluate(() => {
      const handle = window.__mtmuxTerminalHandle;
      if (!handle) {
        throw new Error(
          "no terminal handle on window — the test seam is compiled out of " +
            "production builds, so this is a lab run against a production bundle",
        );
      }
      return handle.inspect();
    });

  const terminal: LabTerminal = {
    root,
    // The gesture surface is the nearest ancestor carrying `touch-none`; it is
    // where the non-passive capture listeners live, so it is where synthetic
    // touches have to land to be seen at all.
    surface: root.locator(
      "xpath=ancestor-or-self::div[contains(@class,'touch-none')][1]",
    ),

    snapshot,

    async waitFor(predicate, message, timeout = 15_000) {
      const deadline = Date.now() + timeout;
      let last: TerminalSnapshot | null = null;
      while (Date.now() < deadline) {
        last = await snapshot();
        if (predicate(last)) return last;
        await page.waitForTimeout(150);
      }
      throw new Error(
        `${message}\nlast viewport (${last?.cols}x${last?.rows}):\n` +
          (last?.lines.join("\n") ?? "<no snapshot>"),
      );
    },

    /*
     * Clicking the container is not enough.
     *
     * xterm renders into a canvas and keeps a hidden `textarea` for input;
     * that textarea is what receives keystrokes, and a click on the wrapping
     * `role="group"` div does not always reach it — there is a gesture surface
     * and, while attaching, an overlay in between. Focusing it directly is
     * also the honest model of what a tap does, since xterm's own click
     * handler ends in exactly this call.
     */
    async focus() {
      await root.click({ position: { x: 40, y: 40 } });
      await root
        .locator("textarea.xterm-helper-textarea")
        .focus()
        .catch(() => {
          // Older xterm markup, or a terminal that has not painted yet. The
          // click above is then the only focus attempt, which is what this
          // helper did before and is still usually enough.
        });
    },

    async type(text) {
      await terminal.focus();
      await page.keyboard.type(text);

      /*
       * Match on the text *without* its trailing newline.
       *
       * A buffer line never contains a `\n` — that is the row separator, not a
       * character in a row — so waiting for one is waiting forever. This cost
       * an afternoon, because the failure reads as "the keystrokes never
       * arrived" when they had all arrived correctly.
       */
      const expected = text.replace(/\r?\n$/, "");
      if (!expected) return;

      // The round trip is browser → relay → tmux → pty → back, so the echo is
      // the only proof the input actually landed. Asserting on the local
      // keystroke would pass against a dead socket.
      await terminal.waitFor(
        (snap) => snap.lines.some((l) => l.includes(expected)),
        `typed ${JSON.stringify(text)} into "${session}" and it never echoed back`,
      );
    },

    capture: (opts) => capturePane(session, opts),
    tmuxSize: () => tmuxSize(session),
  };

  return terminal;
}

export { expect };
