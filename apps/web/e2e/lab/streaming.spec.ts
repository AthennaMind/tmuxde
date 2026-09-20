import { test, expect } from "./fixtures";
import { outputProgress, quiesce, restartProfile, tmuxFormat } from "./lab";
import { perfFindings, fidelityFindings } from "./detectors";

/**
 * The terminal under load, which is the half of this product nothing tested.
 *
 * ## The defect this file was written to find, and did not
 *
 * The prediction was this. `cast-player.tsx` paces *recording* playback into
 * 1 MiB `terminal.write()` calls and uses xterm's write-callback as
 * backpressure, with the comment "so the main thread stays free".
 * `terminal-view.tsx` writes every `terminal:output` message to xterm the
 * instant it arrives. So the slower device is the one without the batching,
 * which is backwards — a recording of a firehose would be smoother than the
 * firehose.
 *
 * It is not. Measured at 47 000 lines a second with the CPU throttled ten
 * times slower than this host, frame pacing stays inside budget with room to
 * spare. The premise was wrong: `Terminal.write()` does not render
 * synchronously. xterm enqueues the data and drains the queue under its own
 * per-frame deadline, yielding back to the event loop when it runs out of
 * time — so the live path is already paced, by the emulator rather than by us.
 * The player's chunking solves a different problem, which is feeding a whole
 * recording in at once with no network in between to meter it.
 *
 * This is written down because "we should batch the live writes" is an
 * attractive change that would add a queue, a timer and a failure mode in
 * exchange for nothing measurable. The test stays, throttled to 4×, so that if
 * a future renderer change makes the premise true the rig says so.
 *
 * ## Two different questions
 *
 * "Did the client keep up?" and "did the client end up with the right bytes?"
 * are not the same, and a fast terminal that drops output is worse than a slow
 * one that does not. So the load tests measure pacing *while* it streams, and
 * the fidelity test stops the stream and compares the settled grid against
 * tmux's own rendering.
 */
test.describe("streaming", { tag: "@terminal" }, () => {
  test.setTimeout(120_000);

  test("keeps the main thread usable under a firehose", async ({
    lab,
    page,
    browserName,
  }, testInfo) => {
    const device = testInfo.project.name;
    await lab.open("firehose");

    /*
     * A phone's CPU, not this machine's.
     *
     * Measured unthrottled, this test passes at 47 500 lines a second — which
     * proves nothing about the device it is named after. The whole argument
     * for batching the live write path is that *the slower device is the one
     * without it*: `cast-player.tsx` paces recording playback into 1 MiB
     * chunks against xterm's write-callback "so the main thread stays free",
     * and `terminal-view.tsx` writes every `terminal:output` message the
     * instant it arrives. A desktop CPU hides that difference completely.
     *
     * 4× is roughly a mid-range Android against this host. CDP is Chromium's,
     * so WebKit runs the same test unthrottled — worth having anyway, because
     * it is the only coverage of that engine's renderer under load, and worth
     * saying out loud that it is a weaker claim.
     */
    if (browserName === "chromium") {
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
    }

    try {
      // Long enough to outlast a warm-up and any single GC pause; short enough
      // that five projects do not add a minute each.
      const findings = await perfFindings(
        page,
        { session: "firehose", state: "streaming" },
        device,
        6000,
      );

      expect(
        findings.map((f) => f.detail),
        "the live output path blocked the main thread under load",
      ).toEqual([]);
    } finally {
      if (browserName === "chromium") {
        const cdp = await page.context().newCDPSession(page);
        await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
      }
    }
  });

  test("input still reaches tmux while the firehose runs", async ({
    lab,
    page,
  }) => {
    const term = await lab.open("firehose");

    /*
     * Ctrl-C, and how long it takes to land.
     *
     * The first version of this test typed a marker and waited to see it echo.
     * That cannot work and it is worth writing down why: at five thousand
     * lines a second the echoed line is off the top of the pane within
     * milliseconds, so a perfectly healthy terminal fails it. Worse, the
     * foreground process is the generator, not the shell — the keystrokes go
     * to the generator's stdin and are never echoed at all.
     *
     * "Can I stop this?" is the real question a user has about a runaway
     * session, and it is answerable: press Ctrl-C and watch the server for the
     * moment output stops. That measures browser → relay → tmux → pty under
     * full load, which is the claim worth making, and it fails loudly if the
     * main thread is too busy writing output to send a keystroke.
     */
    await term.focus();

    const started = Date.now();
    await page.keyboard.press("Control+C");

    /*
     * `outputProgress`, not `#{history_size}`.
     *
     * The history is capped at `history-limit`, so a firehose pins it in two
     * seconds and it never moves again. This loop originally read it and
     * declared victory on its first iteration, every time, whether or not the
     * keystroke had arrived — a green test measuring nothing.
     */
    let stoppedAt = 0;
    for (let i = 0; i < 60 && !stoppedAt; i++) {
      await page.waitForTimeout(200);
      const a = outputProgress("firehose");
      await page.waitForTimeout(200);
      if (outputProgress("firehose") === a) stoppedAt = Date.now();
    }

    try {
      expect(stoppedAt, "Ctrl-C never stopped the firehose").toBeGreaterThan(0);
      const elapsed = stoppedAt - started;
      expect(
        elapsed,
        `Ctrl-C took ${elapsed}ms to reach tmux under a firehose`,
      ).toBeLessThan(10_000);

      // And the pane is usable again afterwards, which is the other half of
      // "can I stop this" — a shell that is alive and echoing.
      //
      // `seed.sh` runs each profile as `<generator>; exec bash`, so Ctrl-C
      // ends the generator and the shell replaces it. Typing before that
      // handover completes sends keystrokes to a process on its way out, which
      // is how this read as "input never echoed" against a terminal that was
      // fine a fraction of a second later.
      await expect
        .poll(() => tmuxFormat("firehose", "#{pane_current_command}"), {
          message: "no shell took over after the generator was interrupted",
          timeout: 10_000,
        })
        .toBe("bash");
      await term.type("echo stopped\n");
    } finally {
      restartProfile("firehose", "firehose");
    }
  });

  test("loses nothing once the firehose stops", async ({ lab }, testInfo) => {
    const term = await lab.open("firehose");
    await new Promise((r) => setTimeout(r, 3000));

    quiesce("firehose");
    // The client has to be given the last frames before being judged on them.
    await new Promise((r) => setTimeout(r, 1500));

    const snapshot = await term.snapshot();
    const findings = fidelityFindings(
      snapshot,
      { session: "firehose", state: "settled" },
      testInfo.project.name,
    );

    try {
      expect(
        findings.map((f) => f.detail),
        "the client's grid disagrees with tmux after a burst — bytes were lost",
      ).toEqual([]);
    } finally {
      restartProfile("firehose", "firehose");
    }
  });

  test("survives bytes that are not valid UTF-8", async ({ lab }, testInfo) => {
    const term = await lab.open("garbage");

    /*
     * The assertion is not "it looks right" — there is no right-looking
     * rendering of random high bytes. It is that the client agrees with tmux
     * about what it decided to show, and that the renderer is still alive
     * afterwards. A decoder that desynchronised would disagree from the first
     * bad byte onward and never recover.
     */
    const findings = fidelityFindings(
      await term.snapshot(),
      { session: "garbage", state: "attached" },
      testInfo.project.name,
    );
    expect(findings.map((f) => f.detail)).toEqual([]);

    await term.type("echo still-alive\n");
  });

  test("renders cursor addressing and scroll regions exactly", async ({
    lab,
  }, testInfo) => {
    const term = await lab.open("ctrlseq");

    // Absolute cursor moves, scroll regions, selective clears, save/restore.
    // Any of them mis-implemented shifts content to a different row, which a
    // whole-grid diff sees and a text search would not.
    const findings = fidelityFindings(
      await term.snapshot(),
      { session: "ctrlseq", state: "attached" },
      testInfo.project.name,
    );
    expect(findings.map((f) => f.detail)).toEqual([]);
  });

  test("reflows a 400-column session down to a phone and back", async ({
    lab,
    page,
  }) => {
    const term = await lab.open("longlines");
    const viewport = page.viewportSize()!;

    const settle = async (label: string) => {
      /*
       * The client's grid and tmux's must converge, and `FIT_DEBOUNCE_MS` plus
       * the mount retry ladder means that takes a moment. Polling for
       * agreement is the assertion: if they never converge, the terminal is
       * rendering N columns of content into M columns of grid, silently.
       */
      await expect
        .poll(
          async () => {
            const snap = await term.snapshot();
            const [cols] = term.tmuxSize();
            return snap.cols === cols;
          },
          {
            message: `client and tmux never agreed on a column count ${label}`,
            timeout: 15_000,
          },
        )
        .toBe(true);
    };

    await settle("on attach");

    await page.setViewportSize({
      width: viewport.height,
      height: viewport.width,
    });
    await settle("after rotating");

    await page.setViewportSize(viewport);
    await settle("after rotating back");
  });

  test("a long-idle session still repaints", async ({ lab }) => {
    const term = await lab.open("drip");

    // One line a second, forever. The failure this catches is a socket that
    // has quietly died while the UI still says connected — which only shows up
    // when nothing has been typed for a while, and is therefore the one thing
    // a fast test suite never sees.
    const before = outputProgress("drip");
    await new Promise((r) => setTimeout(r, 6000));

    const after = outputProgress("drip");
    expect(after, "the drip profile stopped producing").toBeGreaterThan(before);

    await term.waitFor(
      (snap) => snap.lines.some((l) => /^drip \d{6}/.test(l)),
      "an idle session stopped repainting",
      10_000,
    );
  });
});
