import { expect, it } from "vitest";
import { matchPalette, mergeRanges, splitHighlight } from "./palette-match";

it("ranks prefix over word start over substring over scattered letters", () => {
  const prefix = matchPalette("open", "Open git graph")!;
  const word = matchPalette("graph", "Open git graph")!;
  const inside = matchPalette("rap", "Open git graph")!;
  const scattered = matchPalette("ogg", "Open git graph")!;
  expect(prefix.score).toBeGreaterThan(word.score);
  expect(word.score).toBeGreaterThan(inside.score);
  expect(inside.score).toBeGreaterThan(scattered.score);
  expect(scattered.ranges).toEqual([
    [0, 1],
    [5, 6],
    [9, 10],
  ]);
});

it("requires every token, falls back to keywords and prefers short labels", () => {
  expect(matchPalette("split right", "Split pane right")?.ranges).toEqual([
    [0, 5],
    [11, 16],
  ]);
  expect(matchPalette("split nowhere", "Split pane right")).toBeNull();
  const keyword = matchPalette("dark", "System theme", ["appearance", "dark mode"]);
  expect(keyword?.ranges).toEqual([]);
  expect(keyword!.score).toBeLessThan(matchPalette("dark", "Dark theme")!.score);
  expect(matchPalette("", "Anything")).toEqual({ score: 0, ranges: [] });
  expect(matchPalette("se", "Settings")!.score).toBeGreaterThan(
    matchPalette("se", "Sessions on this machine")!.score,
  );
});

it("merges overlapping ranges and splits labels for highlighting", () => {
  expect(
    mergeRanges([
      [4, 6],
      [0, 2],
      [1, 3],
      [6, 7],
    ]),
  ).toEqual([
    [0, 3],
    [4, 7],
  ]);
  expect(
    splitHighlight("Open graph", [
      [0, 2],
      [5, 6],
    ]),
  ).toEqual([
    { text: "Op", hit: true },
    { text: "en ", hit: false },
    { text: "g", hit: true },
    { text: "raph", hit: false },
  ]);
});
