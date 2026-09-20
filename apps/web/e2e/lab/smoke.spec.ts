import { test, expect } from "./fixtures";

/**
 * The first test in this repo that drives the terminal against a real tmux.
 *
 * Deliberately small. If this is red, nothing else in `e2e/lab` means anything
 * — the container, the token, CORS, the protocol version, the attach handshake
 * and the pty round trip all have to be right for a single echoed line to come
 * back, so it is also the fastest possible diagnosis of which of them is not.
 */
test.describe("the lab is wired up", { tag: "@terminal" }, () => {
  test("attaches to a session and echoes what is typed", async ({ lab }) => {
    const term = await lab.open("idle");

    await term.type("echo mtmux-lab-is-alive\n");

    const snap = await term.waitFor(
      (s) =>
        s.lines.filter((l) => l.includes("mtmux-lab-is-alive")).length >= 2,
      "the command echoed but never produced output",
    );

    // Two occurrences: the line as typed at the prompt, and the line `echo`
    // printed. One would mean the keystrokes reached tmux but the shell did
    // not run — which is a different failure entirely.
    expect(
      snap.lines.filter((l) => l.includes("mtmux-lab-is-alive")).length,
    ).toBeGreaterThanOrEqual(2);
  });

  test("renders exactly what tmux says it should", async ({ lab }) => {
    const term = await lab.open("unicode");

    /*
     * The whole visible grid, not a hand-picked list of rows.
     *
     * Picking rows by name was wrong in a way worth recording: on
     * `lab-landscape` the viewport is nine rows tall, the `cjk` line has
     * already scrolled off, and asserting it must be present failed against a
     * terminal that was rendering perfectly. Anything that names rows is
     * really asserting a viewport size.
     *
     * Comparing the whole grid is both viewport-agnostic and a much stronger
     * check: the client's viewport and `capture-pane` are two renderings of
     * the same cells at the same size, so they have to agree row for row. A
     * dropped byte, a wide character measured as one cell, a wrap in the wrong
     * column and a stale row all show up here and nowhere else — a screenshot
     * cannot see them and the DOM does not contain them, because the WebGL
     * renderer paints to a canvas.
     */
    const snap = await term.waitFor(
      (s) => s.lines.some((l) => l.startsWith("ruler")),
      "the unicode profile never rendered",
    );

    // Trailing blank rows are not a disagreement: tmux stops emitting at the
    // last non-empty row, the client keeps a full grid.
    const trim = (lines: string[]) => {
      const out = lines.map((l) => l.replace(/\s+$/, ""));
      while (out.length && out[out.length - 1] === "") out.pop();
      return out;
    };

    const rendered = trim(snap.lines);
    const truth = trim(term.capture().split("\n"));

    expect(
      rendered,
      `the client's ${snap.cols}x${snap.rows} viewport disagrees with tmux`,
    ).toEqual(truth);
  });
});
