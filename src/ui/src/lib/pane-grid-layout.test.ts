import { describe, expect, it } from "vitest";
import type { PaneInfo } from "@/protocol";
import {
  HANDLE_INSET,
  HANDLE_SIZE,
  borderBeside,
  borderKey,
  borderSpan,
  borderValue,
  cellBoxes,
  cellLabelLength,
  cellTier,
  dragCell,
  dragClickGuard,
  gridAspect,
  gridHeight,
  layoutSize,
  nearestCell,
  paneCellName,
  paneCellText,
  parseLayout,
  peekLines,
  resizeStep,
  sharedBorders,
  splitHandles,
  splitPath,
  stackDepth,
  stackedMaxHeight,
  type HandleSpot,
} from "./pane-grid-layout";
import { paneLayout, type PaneRect } from "./session-presentation";

function pane(id: number, extra: Partial<PaneInfo> = {}): PaneInfo {
  return {
    id: `%${id}`,
    index: id,
    windowId: "@0",
    active: id === 0,
    zoomed: false,
    command: "bash",
    path: "/home/dev/workspace",
    position: { x: 0, y: 0 },
    dimensions: { cols: 40, rows: 24 },
    ...extra,
  };
}

function panes(count: number): PaneInfo[] {
  return Array.from({ length: count }, (_, id) => pane(id));
}

function rect(id: number, x: number, y: number, width: number, height: number): PaneRect {
  return { id: `%${id}`, x, y, width, height };
}

// 0 on the left at full height. 1 over 2 on the right.
const MAIN_LEFT = "abcd,81x24,0,0{40x24,0,0,0,40x24,41,0[40x11,41,0,1,40x12,41,12,2]}";

// Four panes from the plan mockup: 0 top left, 1 over 2 on the right, 3 across the bottom.
const MOCKUP =
  "b6a2,81x24,0,0[81x16,0,0{48x16,0,0,0,32x16,49,0[32x8,49,0,1,32x7,49,9,2]},81x7,0,17,3]";

// Two rows of two. The vertical borders line up on screen but sit in different containers.
const TWO_ROWS = "c0de,81x25,0,0[81x12,0,0{40x12,0,0,0,40x12,41,0,1},81x12,0,13{40x12,0,13,2,40x12,41,13,3}]";

describe("grid aspect and height", () => {
  it("draws the window at an 8x16 cell", () => {
    expect(gridAspect({ cols: 200, rows: 50 })).toBe(2);
    expect(gridAspect({ cols: 80, rows: 24 })).toBeCloseTo(1.667, 3);
  });

  it("falls back to 2:1 without dimensions", () => {
    expect(gridAspect()).toBe(2);
    expect(gridAspect(null)).toBe(2);
  });

  it("clamps the height between 56 and 128px", () => {
    expect(gridHeight(252, { cols: 200, rows: 50 })).toBe(126);
    expect(gridHeight(252, { cols: 80, rows: 24 })).toBe(128);
    expect(gridHeight(100)).toBe(56);
    expect(gridHeight(160)).toBe(80);
  });

  it("counts the panes stacked in one column", () => {
    const side = "aaaa,200x50,0,0{100x50,0,0,0,99x50,101,0,1}";
    const tile = "bbbb,200x50,0,0{100x50,0,0[100x25,0,0,0,100x24,0,26,2],99x50,101,0[99x25,101,0,1,99x24,101,26,3]}";
    const six =
      "cccc,200x50,0,0[200x16,0,0{99x16,0,0,0,100x16,100,0,1},200x16,0,17{99x16,0,17,2,100x16,100,17,3},200x16,0,34{99x16,0,34,4,100x16,100,34,5}]";
    expect(stackDepth(paneLayout("aaaa,200x50,0,0,0", panes(1)))).toBe(1);
    expect(stackDepth(paneLayout(side, panes(2)))).toBe(1);
    expect(stackDepth(paneLayout(tile, panes(4)))).toBe(2);
    expect(stackDepth(paneLayout(six, panes(6)))).toBe(3);
    // 1 over 2 on the right, over 3 across the bottom: three high.
    expect(stackDepth(paneLayout(MOCKUP, panes(4)))).toBe(3);
    expect(stackDepth(paneLayout(MAIN_LEFT, panes(3)))).toBe(2);
    expect(stackDepth([])).toBe(0);
  });

  it("caps a sparse grid lower than a dense one", () => {
    expect(stackedMaxHeight(0)).toBe(56);
    expect(stackedMaxHeight(1)).toBe(58);
    expect(stackedMaxHeight(2)).toBe(118);
    expect(stackedMaxHeight(3)).toBe(128);
    expect(stackedMaxHeight(8)).toBe(128);
  });

  it("reads the window size from the layout root", () => {
    expect(layoutSize(MAIN_LEFT)).toEqual({ cols: 81, rows: 24 });
    expect(layoutSize("200x50,0,0,7")).toEqual({ cols: 200, rows: 50 });
    expect(layoutSize("")).toBeNull();
  });
});

describe("cell tiers", () => {
  it("picks the richest content that fits", () => {
    expect(cellTier(120, 60)).toBe("full");
    expect(cellTier(96, 36)).toBe("full");
    expect(cellTier(95, 60)).toBe("label");
    expect(cellTier(200, 35)).toBe("label");
    expect(cellTier(48, 20)).toBe("label");
    expect(cellTier(47, 40)).toBe("icon");
    expect(cellTier(100, 19)).toBe("icon");
    expect(cellTier(24, 18)).toBe("icon");
    expect(cellTier(23, 40)).toBe("box");
    expect(cellTier(200, 17)).toBe("box");
  });

  it("shows a label only when the whole of it or four characters fit", () => {
    // 54 px leaves 24 px of text, 3 characters of the 12 px chrome face.
    expect(cellTier(54, 26, 3)).toBe("label");
    expect(cellTier(54, 26, 9)).toBe("icon");
    // 59 px leaves 4 characters: "wor…" still says something.
    expect(cellTier(59, 26, 9)).toBe("label");
    expect(cellTier(76, 37, 9)).toBe("label");
    expect(cellTier(48, 20, 2)).toBe("label");
    expect(cellTier(48, 20, 3)).toBe("icon");
    // The full tier has room by its own minimum.
    expect(cellTier(96, 36, 40)).toBe("full");
  });

  it("measures the part of a label a cell keeps", () => {
    expect(cellLabelLength(paneCellText({ command: "bash", path: "/workspace" }))).toBe(9);
    expect(cellLabelLength(paneCellText({ command: "bash", path: "/tmp" }))).toBe(3);
    expect(cellLabelLength(paneCellText({ command: "top", path: "/workspace" }))).toBe(3);
    expect(cellLabelLength(paneCellText({ command: "claude", path: "/workspace" }))).toBe(11);
  });
});

describe("cell text", () => {
  it("shows the folder for a shell", () => {
    expect(paneCellText(pane(0))).toEqual({ kind: "terminal", label: "~/workspace" });
    expect(paneCellText(pane(0, { command: "-zsh", path: "/srv/app/api/src" }))).toEqual({
      kind: "terminal",
      label: "…/api/src",
    });
  });

  it("falls back to Terminal for a shell without a folder", () => {
    expect(paneCellText(pane(0, { path: undefined }))).toEqual({ kind: "terminal", label: "Terminal" });
  });

  it("shows the process with the folder second for anything else", () => {
    expect(paneCellText(pane(0, { command: "claude" }))).toEqual({
      kind: "agent",
      label: "Claude Code",
      folder: "~/workspace",
    });
    expect(paneCellText(pane(0, { command: "top", path: undefined }))).toEqual({
      kind: "process",
      label: "top",
      folder: undefined,
    });
  });

  it("cuts a path before its last segment", () => {
    expect(splitPath("…/internal/hub")).toEqual(["…/internal/", "hub"]);
    expect(splitPath("/workspace/cmd")).toEqual(["/workspace/", "cmd"]);
    expect(splitPath("/workspace")).toEqual(["/", "workspace"]);
    expect(splitPath("~")).toEqual(["", "~"]);
    expect(splitPath("/")).toEqual(["", "/"]);
    expect(splitPath("Terminal")).toEqual(["", "Terminal"]);
  });

  it("names the cell with index, process, full folder and state", () => {
    expect(paneCellName(pane(1), { focused: true })).toBe("Pane 1, shell in ~/workspace, focused");
    expect(paneCellName(pane(0, { command: "claude", path: "/home/dev/a/b/c" }), { zoomed: true })).toBe(
      "Pane 0, Claude Code in ~/a/b/c, zoomed",
    );
    expect(paneCellName(pane(3, { command: "top", path: undefined }))).toBe("Pane 3, top");
  });
});

describe("cell boxes", () => {
  it("grows every edge to the middle of its separator so cells tile the grid", () => {
    const boxes = cellBoxes(paneLayout(MAIN_LEFT, panes(3)));
    expect(boxes[0]).toMatchObject({ id: "%0", x: 0, y: 0, height: 1 });
    expect(boxes[0]!.width).toBeCloseTo(40.5 / 81);
    expect(boxes[1]!.x).toBeCloseTo(40.5 / 81);
    expect(boxes[1]!.width).toBeCloseTo(40.5 / 81);
    expect(boxes[1]!.height).toBeCloseTo(11.5 / 24);
    expect(boxes[2]!.y).toBeCloseTo(11.5 / 24);
    expect(boxes[2]!.y + boxes[2]!.height).toBeCloseTo(1);
  });

  it("keeps a single pane at full size", () => {
    expect(cellBoxes([rect(0, 0, 0, 1, 1)])).toEqual([rect(0, 0, 0, 1, 1)]);
  });
});

describe("nearest cell", () => {
  const main = paneLayout(MAIN_LEFT, panes(3));
  const mockup = paneLayout(MOCKUP, panes(4));

  it("moves across the main split and back", () => {
    // Pane 2 is a row taller than pane 1, so its center is closer.
    expect(nearestCell(main, "%0", "right")).toBe("%2");
    expect(nearestCell(main, "%2", "left")).toBe("%0");
    expect(nearestCell(main, "%1", "left")).toBe("%0");
  });

  it("moves within the stacked side", () => {
    expect(nearestCell(main, "%1", "down")).toBe("%2");
    expect(nearestCell(main, "%2", "up")).toBe("%1");
  });

  it("returns null at the window edge", () => {
    expect(nearestCell(main, "%0", "left")).toBeNull();
    expect(nearestCell(main, "%0", "up")).toBeNull();
    expect(nearestCell(main, "%0", "down")).toBeNull();
    expect(nearestCell(main, "%1", "right")).toBeNull();
    expect(nearestCell(main, "%9", "right")).toBeNull();
  });

  it("prefers the cell straight across over a diagonal one", () => {
    expect(nearestCell(mockup, "%0", "down")).toBe("%3");
    expect(nearestCell(mockup, "%2", "down")).toBe("%3");
    expect(nearestCell(mockup, "%3", "up")).toBe("%0");
  });

  it("prefers the closest edge, then the closest center", () => {
    const rects = [
      rect(0, 0, 0, 0.3, 1),
      rect(1, 0.31, 0, 0.69, 0.2),
      rect(2, 0.31, 0.21, 0.1, 0.79),
      rect(3, 0.42, 0.21, 0.58, 0.79),
    ];
    expect(nearestCell(rects, "%0", "right")).toBe("%2");
    expect(nearestCell(rects, "%2", "right")).toBe("%3");
    expect(nearestCell(rects, "%3", "up")).toBe("%1");
  });

  it("breaks ties in reading order", () => {
    // From the left pane, 1 and 2 sit at the same distance. The upper one wins.
    const even = [rect(0, 0, 0, 0.5, 1), rect(1, 0.51, 0, 0.49, 0.495), rect(2, 0.51, 0.505, 0.49, 0.495)];
    expect(nearestCell(even, "%0", "right")).toBe("%1");
    expect(nearestCell(even, "%1", "left")).toBe("%0");
  });
});

describe("layout tree", () => {
  it("parses nested containers", () => {
    expect(parseLayout(MAIN_LEFT)).toEqual({
      type: "leftright",
      x: 0,
      y: 0,
      width: 81,
      height: 24,
      cells: [
        { type: "pane", id: "%0", x: 0, y: 0, width: 40, height: 24 },
        {
          type: "topbottom",
          x: 41,
          y: 0,
          width: 40,
          height: 24,
          cells: [
            { type: "pane", id: "%1", x: 41, y: 0, width: 40, height: 11 },
            { type: "pane", id: "%2", x: 41, y: 12, width: 40, height: 12 },
          ],
        },
      ],
    });
  });

  it("parses a single pane with and without a checksum", () => {
    expect(parseLayout("1a2b,80x24,0,0,5")).toEqual({
      type: "pane",
      id: "%5",
      x: 0,
      y: 0,
      width: 80,
      height: 24,
    });
    expect(parseLayout("80x24,0,0,5")).not.toBeNull();
  });

  it("returns null for broken layouts", () => {
    for (const layout of ["", "abcd,", "abcd,80x24,0,0", "abcd,80x24,0,0{40x24,0,0,1", "abcd,80x24,0,0,1junk"]) {
      expect(parseLayout(layout)).toBeNull();
    }
  });
});

describe("shared borders", () => {
  it("finds the main split and the stacked split", () => {
    const borders = sharedBorders(MAIN_LEFT, panes(3));
    expect(borders).toEqual([
      {
        orientation: "vertical",
        position: 40.5 / 81,
        start: 0,
        end: 1,
        cell: 40,
        min: 0,
        max: 81,
        before: ["%0"],
        after: ["%1", "%2"],
        owner: "%0",
      },
      {
        orientation: "horizontal",
        position: 11.5 / 24,
        start: 41 / 81,
        end: 1,
        cell: 11,
        min: 0,
        max: 24,
        before: ["%1"],
        after: ["%2"],
        owner: "%1",
      },
    ]);
  });

  it("keeps borders that line up on screen apart", () => {
    const vertical = sharedBorders(TWO_ROWS, panes(4)).filter((b) => b.orientation === "vertical");
    expect(vertical.map((b) => [b.before, b.after, b.owner, b.start, b.end])).toEqual([
      [["%0"], ["%1"], "%0", 0, 12 / 25],
      [["%2"], ["%3"], "%2", 13 / 25, 1],
    ]);
  });

  it("lists every pane along a border between containers", () => {
    const horizontal = sharedBorders(TWO_ROWS, panes(4)).find((b) => b.orientation === "horizontal");
    expect(horizontal).toMatchObject({
      before: ["%0", "%1"],
      after: ["%2", "%3"],
      cell: 12,
      start: 0,
      end: 1,
    });
    // resize-pane -D on 0 walks up to the top row and grows it.
    expect(horizontal?.owner).toBe("%0");
  });

  it("owns the border from the last cell when the cell before cannot reach it", () => {
    // Left: a stack of two side by side pairs. Right: pane 4. Every pane on
    // the left stops at its own pair, so only pane 4, the last cell, moves
    // the outer border.
    const layout =
      "abcd,81x25,0,0{40x25,0,0[40x12,0,0{20x12,0,0,0,19x12,21,0,1},40x12,0,13{20x12,0,13,2,19x12,21,13,3}],40x25,41,0,4}";
    const outer = sharedBorders(layout, panes(5)).find((b) => b.cell === 40);
    expect(outer).toMatchObject({ before: ["%1", "%3"], after: ["%4"], owner: "%4" });
  });

  it("has no owner when neither side reaches the border", () => {
    const layout =
      "abcd,122x25,0,0{40x25,0,0[40x12,0,0{20x12,0,0,0,19x12,21,0,1},40x12,0,13{20x12,0,13,2,19x12,21,13,3}],40x25,41,0,4,40x25,82,0,5}";
    const outer = sharedBorders(layout, panes(6)).find((b) => b.cell === 40);
    expect(outer?.owner).toBeNull();
    expect(sharedBorders(layout, panes(6)).find((b) => b.cell === 81)?.owner).toBe("%4");
  });

  it("is empty for a single pane, a broken layout or other panes", () => {
    expect(sharedBorders("abcd,80x24,0,0,0", panes(1))).toEqual([]);
    expect(sharedBorders("", panes(2))).toEqual([]);
    expect(sharedBorders(MAIN_LEFT, panes(2))).toEqual([]);
    expect(sharedBorders(MAIN_LEFT, [pane(0), pane(1), pane(7)])).toEqual([]);
  });
});

describe("shared borders against real tmux", () => {
  // internal/node/tmux/tmux_test.go testResizeOwner applies these layouts,
  // resizes the owner and reads back where the border went.
  it("owns the outer border of the mockup from the top left pane", () => {
    const borders = sharedBorders(MOCKUP, panes(4));
    expect(borders.map((b) => [b.orientation, b.cell, b.before, b.after, b.owner])).toEqual([
      ["horizontal", 16, ["%0", "%2"], ["%3"], "%0"],
      ["vertical", 48, ["%0"], ["%1", "%2"], "%0"],
      ["horizontal", 8, ["%1"], ["%2"], "%1"],
    ]);
  });
});

describe("border drag", () => {
  const [main, stack] = sharedBorders(MAIN_LEFT, panes(3));

  it("keys a border by the panes on both sides", () => {
    expect(borderKey(main!)).toBe("v:%0|%1,%2");
    expect(borderKey(stack!)).toBe("h:%1|%2");
    // A resize changes the cell and keeps the key.
    const moved = sharedBorders(
      "abcd,81x24,0,0{45x24,0,0,0,35x24,46,0[35x11,46,0,1,35x12,46,12,2]}",
      panes(3),
    );
    expect(moved.map(borderKey)).toEqual(["v:%0|%1,%2", "h:%1|%2"]);
    expect(moved[0]!.cell).toBe(45);
  });

  it("grows the span over the separators at inner ends", () => {
    expect(borderSpan(main!, { cols: 81, rows: 24 })).toEqual({ start: 0, end: 1 });
    const span = borderSpan(stack!, { cols: 81, rows: 24 });
    expect(span.start).toBeCloseTo(40.5 / 81);
    expect(span.end).toBe(1);
    const top = sharedBorders(TWO_ROWS, panes(4)).find((b) => b.orientation === "vertical")!;
    expect(borderSpan(top, { cols: 81, rows: 25 }).end).toBeCloseTo(12.5 / 25);
  });

  it("turns px into whole columns and keeps a column on each side", () => {
    // 252px over 81 columns is about 3.1px a column.
    const cellPx = 252 / 81;
    expect(dragCell(main!, 0, cellPx)).toBe(40);
    expect(dragCell(main!, 1, cellPx)).toBe(40);
    expect(dragCell(main!, 2, cellPx)).toBe(41);
    expect(dragCell(main!, -31, cellPx)).toBe(30);
    expect(dragCell(main!, 9999, cellPx)).toBe(79);
    expect(dragCell(main!, -9999, cellPx)).toBe(1);
    expect(dragCell(main!, 50, 0)).toBe(40);
  });

  it("sends the direction and amount that move the border", () => {
    expect(resizeStep("vertical", 40, 45)).toEqual({ direction: "R", amount: 5 });
    expect(resizeStep("vertical", 45, 43)).toEqual({ direction: "L", amount: 2 });
    expect(resizeStep("horizontal", 11, 12)).toEqual({ direction: "D", amount: 1 });
    expect(resizeStep("horizontal", 11, 6)).toEqual({ direction: "U", amount: 5 });
    expect(resizeStep("vertical", 40, 40)).toBeNull();
  });

  it("finds the border on each side of a pane", () => {
    const borders = sharedBorders(MOCKUP, panes(4));
    expect(borderBeside(borders, "%0", "right")?.cell).toBe(48);
    expect(borderBeside(borders, "%0", "down")?.cell).toBe(16);
    expect(borderBeside(borders, "%0", "left")).toBeNull();
    expect(borderBeside(borders, "%2", "up")?.cell).toBe(8);
    expect(borderBeside(borders, "%2", "left")?.cell).toBe(48);
    expect(borderBeside(borders, "%3", "up")?.cell).toBe(16);
    expect(borderBeside(borders, "%3", "down")).toBeNull();
  });

  it("skips a border no pane can move", () => {
    const layout =
      "abcd,122x25,0,0{40x25,0,0[40x12,0,0{20x12,0,0,0,19x12,21,0,1},40x12,0,13{20x12,0,13,2,19x12,21,13,3}],40x25,41,0,4,40x25,82,0,5}";
    const borders = sharedBorders(layout, panes(6));
    expect(borderBeside(borders, "%1", "right")).toBeNull();
    expect(borderBeside(borders, "%4", "left")).toBeNull();
    expect(borderBeside(borders, "%4", "right")?.owner).toBe("%4");
  });

  it("reports the size before the border as its value", () => {
    expect(borderValue(main!)).toEqual({ now: 40, min: 1, max: 79 });
    expect(borderValue(stack!)).toEqual({ now: 11, min: 1, max: 22 });
  });
});

describe("split handles", () => {
  const box = (spot: HandleSpot) => ({ x: spot.x, y: spot.y });
  const clear = (spots: HandleSpot[], width: number, height: number, corner: boolean) => {
    for (const a of spots) {
      expect(a.x).toBeGreaterThanOrEqual(HANDLE_INSET);
      expect(a.y).toBeGreaterThanOrEqual(HANDLE_INSET);
      expect(a.x + HANDLE_SIZE).toBeLessThanOrEqual(width - HANDLE_INSET);
      expect(a.y + HANDLE_SIZE).toBeLessThanOrEqual(height - HANDLE_INSET);
    }
    const boxes = spots.map(box);
    if (corner) boxes.push({ x: width - HANDLE_INSET - HANDLE_SIZE, y: HANDLE_INSET });
    for (const [i, a] of boxes.entries()) {
      for (const b of boxes.slice(i + 1)) {
        const apart =
          a.x + HANDLE_SIZE <= b.x ||
          b.x + HANDLE_SIZE <= a.x ||
          a.y + HANDLE_SIZE <= b.y ||
          b.y + HANDLE_SIZE <= a.y;
        expect(apart).toBe(true);
      }
    }
  };

  it("centres both handles on a roomy cell", () => {
    expect(splitHandles(160, 100, true)).toEqual([
      { direction: "h", x: 132, y: 38 },
      { direction: "v", x: 68, y: 72 },
    ]);
  });

  it("moves the right handle under the corner button on a short cell", () => {
    const spots = splitHandles(120, 56, true);
    expect(spots.find((s) => s.direction === "h")).toEqual({ direction: "h", x: 92, y: 28 });
    clear(spots, 120, 56, true);
  });

  it("never overlaps the corner, the border strips or each other", () => {
    for (const width of [24, 32, 40, 56, 64, 80, 120, 252]) {
      for (const height of [18, 24, 32, 40, 56, 64, 80, 128]) {
        for (const corner of [true, false]) {
          clear(splitHandles(width, height, corner), width, height, corner);
        }
      }
    }
  });

  it("keeps the middle of a cell free, so a click there selects", () => {
    for (const width of [40, 56, 64, 80, 120, 252]) {
      for (const height of [24, 36, 48, 56, 64, 80, 128]) {
        for (const spot of splitHandles(width, height, true)) {
          const box = { x: spot.x, y: spot.y };
          const middle =
            box.x < width / 2 &&
            width / 2 < box.x + HANDLE_SIZE &&
            box.y < height / 2 &&
            height / 2 < box.y + HANDLE_SIZE;
          expect(middle).toBe(false);
          if (spot.direction === "h") expect(box.x).toBeGreaterThanOrEqual(width / 2);
          else expect(box.y).toBeGreaterThanOrEqual(height / 2);
        }
      }
    }
  });

  it("drops the handles that do not fit and keeps the one along the long side", () => {
    expect(splitHandles(30, 30, false)).toEqual([]);
    // Too short for a bottom handle outside the middle, room for a right one.
    expect(splitHandles(116, 36, false).map((s) => s.direction)).toEqual(["h"]);
    // With the corner button there, the right handle has no room either.
    expect(splitHandles(116, 36, true)).toEqual([]);
    expect(splitHandles(60, 56, false).map((s) => s.direction)).toEqual(["h", "v"]);
    expect(splitHandles(48, 120, true).map((s) => s.direction)).toEqual(["v"]);
    expect(splitHandles(64, 120, true).map((s) => s.direction)).toEqual(["h", "v"]);
  });
});

describe("peek lines", () => {
  it("keeps the last lines with text and drops the blank rows below them", () => {
    const content = ["one", "two", "$ ", "", "", ""].join("\n");
    expect(peekLines(content, 2)).toEqual(["two", "$"]);
  });

  it("keeps blank lines between lines with text", () => {
    expect(peekLines("a\n\nb\n", 12)).toEqual(["a", "", "b"]);
  });

  it("takes twelve lines by default", () => {
    const content = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n");
    const lines = peekLines(content);
    expect(lines).toHaveLength(12);
    expect(lines[0]).toBe("line 18");
    expect(lines.at(-1)).toBe("line 29");
  });

  it("is empty for an empty pane", () => {
    expect(peekLines("")).toEqual([]);
    expect(peekLines("\n\n  \n")).toEqual([]);
  });
});

describe("dragClickGuard", () => {
  it("swallows the click that follows a drop on the cell, once", () => {
    const clicks = dragClickGuard();
    clicks.press();
    clicks.release(true);
    expect(clicks.click(1)).toBe(true);
    expect(clicks.click(1)).toBe(false);
  });

  it("lets a release away from the cell leave the next click alone", () => {
    const clicks = dragClickGuard();
    clicks.press();
    clicks.release(false);
    expect(clicks.click(1)).toBe(false);
  });

  it("never swallows keyboard activation, even with a mark no click took", () => {
    // Escape cancelled a drag and the release fired no click on the cell.
    // Enter on a cell later is a select.
    const clicks = dragClickGuard();
    clicks.release(true);
    expect(clicks.click(0)).toBe(false);
    expect(clicks.click(1)).toBe(false);
  });

  it("drops a stale mark on the next press", () => {
    const clicks = dragClickGuard();
    clicks.release(true);
    clicks.press();
    expect(clicks.click(1)).toBe(false);
  });

  it("lets plain clicks through", () => {
    const clicks = dragClickGuard();
    clicks.press();
    expect(clicks.click(1)).toBe(false);
    expect(clicks.click(0)).toBe(false);
  });
});
