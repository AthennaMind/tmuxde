import { test, expect } from "./fixtures";
import { exitCopyMode, tmuxFormat } from "./lab";
import {
  playGesture,
  swipe,
  drag,
  pinch,
  tap,
  setVisualViewport,
} from "./touch";

/**
 * Every touch gesture, end to end, against a real tmux.
 *
 * ## What this covers that the unit suite does not
 *
 * `lib/touch-gestures.ts` is a pure reducer with its own tests, and they are
 * good tests — but they prove the reducer decides correctly given inputs. They
 * cannot prove that the surface delivers those inputs, that the effects reach
 * the relay, or that tmux does the thing the user asked for. Every bug in that
 * file's own header was a wiring bug, not a decision bug: a handler that never
 * claimed the first finger, a guard that latched until reload, a `pan-y`
 * inherited from a wrapper. This is the layer those lived in.
 *
 * ## Why tmux is the oracle
 *
 * Asserting that the tab strip highlights a different tab asks the component
 * whether it agrees with itself. `#{window_index}` and `#{pane_in_mode}` come
 * from the server, and are the only statements of what actually happened.
 */

const phones = ["lab-phone", "lab-webkit", "lab-landscape", "lab-tablet"];

test.describe("touch gestures", { tag: "@terminal" }, () => {
  // `test.info()` rather than the fixture-shaped `test.skip(fn)` overload,
  // which passes fixtures first and made `testInfo` undefined here.
  test.beforeEach(() => {
    test.skip(
      !phones.includes(test.info().project.name),
      "touch gestures need a coarse pointer",
    );
  });

  test("a fast horizontal swipe changes window, and tmux agrees", async ({
    lab,
  }) => {
    const term = await lab.open("many-windows");
    const box = (await term.surface.boundingBox())!;
    const before = tmuxFormat("many-windows", "#{window_index}");

    // From the middle, travelling well past SWIPE_FAR_PX (120) and fast
    // enough that the velocity gate is not the thing being tested.
    await playGesture(
      term.surface,
      swipe(
        { x: box.width * 0.75, y: box.height / 2 },
        -Math.min(200, box.width * 0.5),
      ),
      { stepMs: 8 },
    );

    await expect
      .poll(() => tmuxFormat("many-windows", "#{window_index}"), {
        message: "a swipe left never moved tmux off its window",
        timeout: 5000,
      })
      .not.toBe(before);
  });

  test("a slow drag of the same distance does not", async ({ lab }) => {
    const term = await lab.open("many-windows");
    const box = (await term.surface.boundingBox())!;
    const before = tmuxFormat("many-windows", "#{window_index}");

    /*
     * The same travel, played over more than `SWIPE_MAX_MS` (800ms).
     *
     * The bug this guards is named in `touch-gestures.ts`: with no time bound,
     * "a finger resting on the terminal for ten seconds and then lifting 100px
     * to the left switched sessions." 40 samples at 40ms is 1.6 seconds.
     */
    await playGesture(
      term.surface,
      swipe(
        { x: box.width * 0.75, y: box.height / 2 },
        -Math.min(200, box.width * 0.5),
        {
          steps: 40,
        },
      ),
      { stepMs: 40 },
    );

    await expect(async () => {
      expect(tmuxFormat("many-windows", "#{window_index}")).toBe(before);
    }).toPass({ timeout: 2000 });
  });

  test("a short, slow swipe does not commit", async ({ lab }) => {
    const term = await lab.open("many-windows");
    const box = (await term.surface.boundingBox())!;
    const before = tmuxFormat("many-windows", "#{window_index}");

    // Past AXIS_LOCK_PX (12) so it locks as a swipe, short of SWIPE_MIN_PX
    // (64) and slow enough to miss SWIPE_MIN_VELOCITY.
    await playGesture(
      term.surface,
      swipe({ x: box.width / 2, y: box.height / 2 }, -40, { steps: 20 }),
      { stepMs: 30 },
    );

    await expect(async () => {
      expect(tmuxFormat("many-windows", "#{window_index}")).toBe(before);
    }).toPass({ timeout: 2000 });
  });

  test("a vertical drag scrolls tmux history", async ({ lab }) => {
    const term = await lab.open("scrollback");
    const box = (await term.surface.boundingBox())!;

    // Specs share one long-lived tmux server, so whatever ran before may have
    // left this pane scrolled back.
    exitCopyMode("scrollback");

    expect(
      tmuxFormat("scrollback", "#{pane_in_mode}"),
      "the session was already in copy mode before the drag",
    ).toBe("0");

    // Downward is backward in time, matching `tmux:scroll`'s own sign.
    await playGesture(
      term.surface,
      drag({ x: box.width / 2, y: box.height * 0.25 }, box.height * 0.5, 20),
      { stepMs: 16 },
    );

    /*
     * `pane_in_mode` is the ground truth, not the rendered content.
     *
     * tmux enters copy mode to scroll back, and that is a fact about the
     * server. Asserting on the client's buffer instead would pass if the
     * client scrolled its own scrollback without ever telling tmux — which is
     * precisely the failure mode, since on a live attach xterm's own
     * scrollback is empty and tmux owns all the history there is.
     */
    await expect
      .poll(() => tmuxFormat("scrollback", "#{pane_in_mode}"), {
        message: "a downward drag never put tmux into copy mode",
        timeout: 5000,
      })
      .toBe("1");
  });

  test("a tap neither scrolls nor switches", async ({ lab }) => {
    const term = await lab.open("many-windows");
    const before = tmuxFormat("many-windows", "#{window_index}");

    await tap(term.surface);

    /*
     * A tap must stay a tap.
     *
     * It is what focuses the terminal and raises the soft keyboard, and the
     * `pending` phase exists entirely so that a touch which has not moved yet
     * cannot be claimed. A recognizer that locked eagerly would make the
     * keyboard unreachable — the app would look alive and be untypeable.
     */
    await expect(async () => {
      expect(tmuxFormat("many-windows", "#{window_index}")).toBe(before);
      expect(tmuxFormat("many-windows", "#{pane_in_mode}")).toBe("0");
    }).toPass({ timeout: 2000 });
  });

  test("a pinch zooms the font and does not hide the nav", async ({
    lab,
    page,
  }) => {
    const term = await lab.open("idle");
    const before = (await term.snapshot()).cols;

    await playGesture(
      term.surface,
      pinch({ x: 160, y: 160 }, 0.55, { base: 220, steps: 16 }),
      { stepMs: 16 },
    );

    // A smaller font is more columns in the same box. Reading the grid rather
    // than the store keeps this a statement about what the user sees.
    await expect
      .poll(async () => (await term.snapshot()).cols, {
        message: "a pinch-in never changed the terminal's column count",
        timeout: 5000,
      })
      .toBeGreaterThan(before);

    /*
     * And the nav is still there.
     *
     * `keyboard-viewport.ts`'s header names this as a shipped regression: a
     * pinch was misread as a keyboard opening, so zooming in hid the bottom
     * nav. The static half of this is in `detectors/keyboard.ts`; this is the
     * half that goes through a real gesture.
     */
    expect(
      await page.evaluate(
        () => document.documentElement.dataset.keyboard ?? "closed",
      ),
      "a pinch was reported as an open keyboard",
    ).not.toBe("open");
  });

  test("a swipe still works after a search has left a selection", async ({
    lab,
    page,
  }) => {
    const term = await lab.open("many-windows");
    const box = (await term.surface.boundingBox())!;

    /*
     * The latched-guard regression, reproduced through the real path.
     *
     * The search addon calls `terminal.select()` on every hit and nothing ever
     * cleared it, while the old switcher refused any drag "while xterm reports
     * a selection" — so one search on a phone disabled swiping until reload.
     * The fix is the `claim` effect clearing the selection, and this is what
     * proves it is still there.
     */
    await page.evaluate(() => {
      window.__mtmuxTerminalHandle?.search("window");
    });

    const before = tmuxFormat("many-windows", "#{window_index}");
    await playGesture(
      term.surface,
      swipe(
        { x: box.width * 0.75, y: box.height / 2 },
        -Math.min(200, box.width * 0.5),
      ),
      { stepMs: 8 },
    );

    await expect
      .poll(() => tmuxFormat("many-windows", "#{window_index}"), {
        message: "a search left a selection that latched the swipe guard",
        timeout: 5000,
      })
      .not.toBe(before);
  });

  test("a cancelled gesture produces nothing", async ({ lab }) => {
    const term = await lab.open("many-windows");
    const box = (await term.surface.boundingBox())!;
    const before = tmuxFormat("many-windows", "#{window_index}");

    // A system gesture, a notification, an incoming call: the browser takes
    // the touch away mid-drag. Whatever was in flight must be abandoned, not
    // committed on the way out.
    await playGesture(
      term.surface,
      swipe(
        { x: box.width * 0.75, y: box.height / 2 },
        -Math.min(200, box.width * 0.5),
      ),
      { stepMs: 8, endWithCancel: true },
    );

    await expect(async () => {
      expect(tmuxFormat("many-windows", "#{window_index}")).toBe(before);
    }).toPass({ timeout: 2000 });
  });

  test("the keyboard opening does not break the next gesture", async ({
    lab,
    page,
  }) => {
    const term = await lab.open("many-windows");
    const box = (await term.surface.boundingBox())!;

    const baseline = await page.evaluate(
      () => window.visualViewport?.height ?? window.innerHeight,
    );
    await page.evaluate(() => {
      document
        .querySelector<HTMLElement>("textarea.xterm-helper-textarea")
        ?.focus();
    });
    await setVisualViewport(page, { height: baseline - 300, scale: 1 });
    await page.waitForTimeout(300);

    const before = tmuxFormat("many-windows", "#{window_index}");
    await playGesture(
      term.surface,
      swipe(
        { x: box.width * 0.75, y: box.height / 3 },
        -Math.min(200, box.width * 0.5),
      ),
      { stepMs: 8 },
    );

    await expect
      .poll(() => tmuxFormat("many-windows", "#{window_index}"), {
        message:
          "with the keyboard up, a swipe over the shrunken terminal did nothing",
        timeout: 5000,
      })
      .not.toBe(before);

    await setVisualViewport(page, { height: baseline, scale: 1 });
  });
});
