import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";

import { createLiveView, displayWidth, fit, pad, since } from "./live-view.js";

/**
 * The bottom-of-screen owner.
 *
 * What is worth asserting here is not "it printed something" but the two
 * properties the whole design rests on: scrollback contains log lines and
 * never a stranded panel, and the erase is exactly as many rows as were drawn.
 * An erase that is one row short leaves a ghost; one row long eats real
 * output, which is the worse of the two and the silent one.
 */

function fakeTty(rows = 40, columns = 80) {
  const stream = new PassThrough() as unknown as NodeJS.WriteStream;
  const chunks: string[] = [];
  stream.on("data", (chunk: Buffer) => chunks.push(chunk.toString()));
  Object.assign(stream, { isTTY: true, rows, columns });
  return { stream, chunks, text: () => chunks.join("") };
}

const panel = (lines: string[]) => () => lines;

describe("the panel", () => {
  it("draws below whatever was printed, and erases exactly what it drew", () => {
    const tty = fakeTty();
    const view = createLiveView({ out: tty.stream, enabled: true });

    view.setPanel(panel(["one", "two", "three"]));
    view.stop();

    // Three rows drawn, three rows walked back up.
    expect(tty.text()).toContain("one\ntwo\nthree\n");
    expect(tty.text()).toContain("\x1b[3A\x1b[0J");
  });

  it("erases the old panel before drawing a shorter one", () => {
    const tty = fakeTty();
    const view = createLiveView({ out: tty.stream, enabled: true });

    view.setPanel(panel(["a", "b", "c", "d"]));
    tty.chunks.length = 0;
    view.setPanel(panel(["a"]));

    // Four up, not one. Getting this from the *new* panel's height is the bug
    // that leaves three rows of the old one on screen forever.
    expect(tty.text()).toContain("\x1b[4A\x1b[0J");
  });

  it("puts log lines in the scrollback and the panel back underneath", () => {
    const tty = fakeTty();
    const view = createLiveView({ out: tty.stream, enabled: true });
    view.setPanel(panel(["PANEL"]));
    tty.chunks.length = 0;

    view.log("a device connected");

    const text = tty.text();
    // Erase, then the line, then the panel again — in that order. The panel
    // appearing before the line is what strands a copy of it in the history.
    expect(text.indexOf("\x1b[1A")).toBeLessThan(
      text.indexOf("a device connected"),
    );
    expect(text.indexOf("a device connected")).toBeLessThan(
      text.indexOf("PANEL"),
    );
  });

  it("gives up the region on a resize rather than erasing by a stale count", () => {
    const tty = fakeTty();
    const view = createLiveView({ out: tty.stream, enabled: true });
    view.setPanel(panel(["a", "b"]));
    tty.chunks.length = 0;

    // A narrower terminal may have wrapped the rows we drew, so `drawn` is no
    // longer the number of screen rows they occupy. Walking up by it would
    // erase real output above the panel.
    Object.assign(tty.stream, { columns: 40 });
    tty.stream.emit("resize");

    expect(tty.text()).not.toContain("\x1b[2A");
    expect(tty.text()).toContain("a\nb\n");
  });

  it("is a plain logger when there is no TTY", () => {
    const tty = fakeTty();
    const view = createLiveView({ out: tty.stream, enabled: false });
    view.setPanel(panel(["PANEL"]));

    expect(view.enabled).toBe(false);
    // Nothing drawn, no escapes. A journal reads as an append-only log.
    expect(tty.text()).toBe("");
  });

  it("refuses the region on a terminal too short to spare it", () => {
    const tty = fakeTty(8);
    const view = createLiveView({ out: tty.stream });
    expect(view.enabled).toBe(false);
  });

  it("stops being drawable after stop(), so a late event cannot repaint", () => {
    const tty = fakeTty();
    const view = createLiveView({ out: tty.stream, enabled: true });
    view.setPanel(panel(["PANEL"]));
    view.stop();
    tty.chunks.length = 0;

    // A tunnel that arrives after Ctrl+C is a real case — `start.ts` says so.
    view.refresh();
    view.setPanel(panel(["LATER"]));
    expect(tty.text()).toBe("");
  });
});

describe("column arithmetic", () => {
  it("measures a wide character as two columns", () => {
    expect(displayWidth("ab")).toBe(2);
    expect(displayWidth("日本")).toBe(4);
    expect(displayWidth("é")).toBe(1);
  });

  it("cuts by display width, not by code units", () => {
    // Six columns of CJK is three characters, not six. Slicing by `.length`
    // is what puts every column after this one out by three.
    expect(displayWidth(fit("日本語です", 6))).toBeLessThanOrEqual(6);
    expect(fit("hello", 10)).toBe("hello");
    expect(fit("hello world", 8)).toBe("hello w…");
  });

  it("pads to a true column count", () => {
    expect(displayWidth(pad("日本", 8))).toBe(8);
    expect(displayWidth(pad("hi", 8))).toBe(8);
  });
});

describe("elapsed", () => {
  const now = 1_000_000_000;
  it("uses the coarsest unit that is still true", () => {
    expect(since(now - 5_000, now)).toBe("5s");
    expect(since(now - 90_000, now)).toBe("2m");
    expect(since(now - 3 * 3_600_000, now)).toBe("3h");
    expect(since(now - 5 * 86_400_000, now)).toBe("5d");
  });

  it("never reports the future as a negative age", () => {
    // Clock skew between the relay's `Date.now()` and this one is small but
    // real, and "-1s ago" in a status panel reads as a bug in the product.
    expect(since(now + 5_000, now)).toBe("0s");
  });
});
