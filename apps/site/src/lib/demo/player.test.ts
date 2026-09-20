import { describe, it, expect } from "vitest";

import { siteConfig } from "@/config/site";

import { CHAPTERS, GROUPED, HOME_DEMO } from "./cast";
import {
  chapterAt,
  compileCast,
  frameAt,
  rowWidth,
  settledFrame,
  settledTimeAt,
} from "./player";
import { QR_ROWS } from "./qr-glyph";

/**
 * The engine carries all of this section's risk: the UI is a dumb renderer of
 * whatever `frameAt` returns. Everything asserted here maps to a stated
 * requirement — no layout shift, purity, reduced-motion parity, and the banner
 * matching what the CLI actually prints.
 */

const cast = HOME_DEMO;

/** Times sampled across the whole cast, including outside both ends. */
const SAMPLES = (() => {
  const out: number[] = [-500, -1, 0];
  for (let t = 0; t <= cast.duration; t += 37) out.push(t);
  out.push(cast.duration, cast.duration + 1, cast.duration + 500);
  // Every step boundary, where off-by-one errors live.
  out.push(...cast.offsets);
  return out;
})();

const flat = (row: { text: string }[]) => row.map((s) => s.text).join("");
const screen = (t: number) => frameAt(cast, t).rows.map(flat).join("\n");

describe("compileCast", () => {
  it("durations sum, and the whole thing stays under 45 seconds", () => {
    const sum = cast.steps.reduce((n, s) => n + (s.k === "mark" ? 0 : s.ms), 0);
    expect(cast.duration).toBe(sum);
    expect(cast.duration).toBeLessThan(45_000);
    expect(cast.duration).toBeGreaterThan(10_000);
  });

  it("tiles [0, duration] with contiguous chapter spans", () => {
    expect(cast.chapters.map((c) => c.id)).toEqual([...CHAPTERS]);
    expect(cast.chapters[0]!.start).toBe(0);
    expect(cast.chapters.at(-1)!.end).toBe(cast.duration);
    for (let i = 1; i < cast.chapters.length; i++) {
      expect(cast.chapters[i]!.start).toBe(cast.chapters[i - 1]!.end);
    }
  });

  it("puts every settled time inside its own chapter", () => {
    cast.chapters.forEach((chapter, i) => {
      const t = settledTimeAt(cast, i);
      expect(t).toBeGreaterThanOrEqual(chapter.start);
      expect(t).toBeLessThan(chapter.end);
      expect(chapterAt(cast, t)).toBe(i);
    });
  });

  it("clamps chapterAt outside the cast rather than throwing", () => {
    expect(chapterAt(cast, -9999)).toBe(0);
    expect(chapterAt(cast, cast.duration * 2)).toBe(cast.chapters.length - 1);
  });

  it("compiles an empty cast without special-casing", () => {
    const empty = compileCast({ rows: 3, cols: 10, steps: [] });
    expect(empty.duration).toBe(0);
    expect(empty.chapters).toEqual([]);
    expect(frameAt(empty, 0).rows).toHaveLength(3);
  });
});

describe("no layout shift", () => {
  it("returns exactly cast.rows rows at every sampled time", () => {
    for (const t of SAMPLES) {
      expect(frameAt(cast, t).rows).toHaveLength(cast.rows);
    }
  });

  it("never returns a row wider than cast.cols", () => {
    for (const t of SAMPLES) {
      for (const row of frameAt(cast, t).rows) {
        expect(rowWidth(row)).toBeLessThanOrEqual(cast.cols);
      }
    }
  });

  it("keeps the cursor inside the viewport", () => {
    for (const t of SAMPLES) {
      const { cursor } = frameAt(cast, t);
      expect(cursor!.row).toBeGreaterThanOrEqual(0);
      expect(cursor!.row).toBeLessThan(cast.rows);
      expect(cursor!.col).toBeLessThanOrEqual(cast.cols);
    }
  });
});

describe("purity", () => {
  it("is equal but not identical across calls", () => {
    const a = frameAt(cast, 4000);
    const b = frameAt(cast, 4000);
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
    expect(a.rows[0]).not.toBe(b.rows[0]);
  });

  it("gives the same frames descending as ascending — no hidden state", () => {
    const up = SAMPLES.map(screen);
    const down = [...SAMPLES].reverse().map(screen).reverse();
    expect(down).toEqual(up);
  });

  it("does not alias the cast's own row objects", () => {
    const frame = frameAt(cast, cast.duration);
    for (const row of frame.rows) {
      for (const span of row) {
        span.text = "MUTATED";
      }
    }
    expect(screen(cast.duration)).not.toContain("MUTATED");
  });
});

describe("clamping", () => {
  it("renders the first moment before t=0", () => {
    expect(screen(-500)).toBe(screen(0));
  });

  it("renders the final frame past the end, and reports done", () => {
    expect(screen(cast.duration + 5000)).toBe(screen(cast.duration));
    expect(frameAt(cast, cast.duration).done).toBe(true);
    expect(frameAt(cast, cast.duration - 1).done).toBe(false);
  });
});

describe("typing", () => {
  it("reveals a strictly non-decreasing prefix", () => {
    const typing = cast.steps.findIndex((s) => s.k === "type");
    const start = cast.offsets[typing]!;
    const step = cast.steps[typing]!;
    if (step.k !== "type") throw new Error("expected a type step");

    let previous = "";
    for (let t = start; t <= start + step.ms; t += 20) {
      const line = flat(frameAt(cast, t).rows[0]!);
      expect(step.text.startsWith(line)).toBe(true);
      expect(line.length).toBeGreaterThanOrEqual(previous.length);
      previous = line;
    }
    expect(flat(frameAt(cast, start + step.ms).rows[0]!)).toBe(step.text);
  });
});

describe("reduced motion parity", () => {
  it("every settled frame is fully at rest", () => {
    cast.chapters.forEach((_, i) => {
      const frame = settledFrame(cast, i);
      expect(frame.phone.swipe).toBe(0);
      expect(frame.phone.incoming).toBeNull();
      expect(frame.phone.tapping).toBeNull();
      expect(frame.chapter).toBe(i);
    });
  });

  it("shows no half-typed line in a settled frame", () => {
    // The typing steps both live at the head of their chapter, so by the time
    // the chapter settles the command must be whole.
    const install = settledFrame(cast, 0);
    expect(flat(install.rows[0]!)).toBe(`$ ${siteConfig.install}`);
    const pair = settledFrame(cast, 1);
    expect(pair.rows.map(flat).join("\n")).toContain("$ mtmux");
  });
});

describe("the phone", () => {
  it("moves monotonically through a swipe and commits the target", () => {
    const i = cast.steps.findIndex((s) => s.k === "swipe");
    const step = cast.steps[i]!;
    if (step.k !== "swipe") throw new Error("expected a swipe step");
    const start = cast.offsets[i]!;

    let previous = 0;
    for (let t = start + 1; t < start + step.ms; t += 20) {
      const { phone } = frameAt(cast, t);
      expect(phone.incoming).toBe(step.to);
      expect(Math.abs(phone.swipe)).toBeGreaterThanOrEqual(Math.abs(previous));
      expect(Math.abs(phone.swipe)).toBeLessThanOrEqual(1);
      previous = phone.swipe;
    }

    const after = frameAt(cast, start + step.ms).phone;
    expect(after.screen).toBe(step.to);
    expect(after.incoming).toBeNull();
    expect(after.swipe).toBe(0);
  });

  it("enters the full code by the end of the pair chapter", () => {
    expect(settledFrame(cast, 1).phone.code).toBe(GROUPED.replaceAll(" ", ""));
  });

  it("is only marked paired from the attach chapter onwards", () => {
    // Indexed by name, not by number. This used to read `2`, and inserting the
    // approval chapter ahead of `attach` silently made it an assertion about a
    // different moment — which is the failure mode a positional index has.
    const at = (id: (typeof CHAPTERS)[number]) => CHAPTERS.indexOf(id);
    expect(settledFrame(cast, at("pair")).phone.paired).toBe(false);
    // Still not paired while the machine is being asked: that is the whole
    // point of the chapter.
    expect(settledFrame(cast, at("approve")).phone.paired).toBe(false);
    expect(settledFrame(cast, at("attach")).phone.paired).toBe(true);
    expect(frameAt(cast, cast.duration).phone.paired).toBe(true);
  });
});

/**
 * Drift fence against `apps/cli/src/banner.ts`.
 *
 * A banner nobody recognises when they run the thing is worse than no banner
 * at all, and the two files have no compile-time link. If one of these fails,
 * the CLI's output changed — update the cast, do not delete the assertion.
 */
describe("banner fidelity", () => {
  const settled = settledFrame(cast, 1).rows.map(flat).join("\n");

  it.each([
    ["the brand line", `›  mtmux`],
    ["the version, from siteConfig", siteConfig.version],
    ["the scan prompt", "Scan to open your terminal"],
    ["the typed-code fallback", "or go to"],
    ["the app host, from siteConfig", siteConfig.appHost],
    ["the grouped nine-digit code", GROUPED],
    ["the local address label", "Local"],
    ["the network address label", "Network"],
    ["the wait line", "Waiting for a device…"],
    ["the stop hint", "Ctrl+C to stop."],
  ])("keeps %s", (_label, text) => {
    expect(settled).toContain(text);
  });

  it("never types the version or host as a literal", () => {
    // Guards the rule rather than the value: if someone inlines "0.6.3", this
    // still passes — but `siteConfig.version` moving would then break the
    // assertion above, which is the point.
    expect(siteConfig.version).not.toBe("");
    expect(siteConfig.appHost).not.toBe("");
  });
});

/**
 * The same fence, for the gate.
 *
 * `access-prompt.ts` asks "Let it in? [y/N]" with no digits on a code pairing,
 * deliberately: the nine-digit code was the shared secret, so there is nothing
 * left to compare. If this demo ever grows a six-digit comparison here it is
 * showing a check the product does not perform, which is worse than showing
 * nothing.
 */
describe("approval fidelity", () => {
  const settled = settledFrame(cast, CHAPTERS.indexOf("approve"))
    .rows.map(flat)
    .join("\n");

  it.each([
    ["the question", "Let it in?"],
    ["the default, which is no", "[y/N]"],
    ["who is asking", "Safari on iPhone"],
  ])("keeps %s", (_label, text) => {
    expect(settled).toContain(text);
  });

  it("shows no digits to compare, because there are none", () => {
    expect(settled).not.toContain("Matches what your browser shows?");
  });
});

describe("the QR glyph", () => {
  it("has rows of equal width, so the block cannot shear", () => {
    const widths = new Set(QR_ROWS.map((row) => [...row].length));
    expect(widths.size).toBe(1);
  });

  it("is present in the settled pair frame", () => {
    expect(settledFrame(cast, 1).rows.map(flat).join("\n")).toContain(
      QR_ROWS[0]!.trim(),
    );
  });
});
