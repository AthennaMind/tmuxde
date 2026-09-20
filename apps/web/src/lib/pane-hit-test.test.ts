import { describe, expect, it } from "vitest";
import type { PaneInfo } from "@repo/protocol";

import { paneAtPoint, type GridGeometry } from "./pane-hit-test";

/**
 * Cells, not pixels — but the input is pixels, so the arithmetic between them
 * is the whole subject. Every case below is a point a thumb could plausibly
 * land on.
 */

const GRID: GridGeometry = {
  left: 10,
  top: 20,
  cellWidth: 8,
  cellHeight: 16,
  cols: 80,
  rows: 24,
};

const pane = (
  id: string,
  x: number,
  y: number,
  cols: number,
  rows: number,
): PaneInfo =>
  ({
    id,
    index: 0,
    windowId: "@1",
    active: false,
    zoomed: false,
    position: { x, y },
    dimensions: { cols, rows },
  }) as PaneInfo;

/** Two side by side over a 40-column split, with a border column between. */
const LEFT = pane("%1", 0, 0, 40, 23);
const RIGHT = pane("%2", 41, 0, 39, 23);

const at = (col: number, row: number) => ({
  x: GRID.left + col * GRID.cellWidth + 1,
  y: GRID.top + row * GRID.cellHeight + 1,
});

describe("paneAtPoint", () => {
  it("answers with the pane the point is inside", () => {
    expect(paneAtPoint(at(5, 5), GRID, [LEFT, RIGHT])?.id).toBe("%1");
    expect(paneAtPoint(at(60, 5), GRID, [LEFT, RIGHT])?.id).toBe("%2");
  });

  it("is exclusive at the far edge, so two panes never both claim a cell", () => {
    // Column 39 is the last of a 40-wide pane starting at 0. Column 40 is the
    // border. An inclusive test here hands the same cell to both panes.
    expect(paneAtPoint(at(39, 0), GRID, [LEFT, RIGHT])?.id).toBe("%1");
    expect(paneAtPoint(at(40, 0), GRID, [LEFT, RIGHT])).toBeNull();
  });

  it("returns nothing for the status line under the panes", () => {
    // Row 23 is tmux's status line: it is in the grid but in no pane, and a
    // menu for a pane the user did not press is worse than no menu.
    expect(paneAtPoint(at(5, 23), GRID, [LEFT, RIGHT])).toBeNull();
  });

  it("gives an unsplit window the benefit of the doubt", () => {
    // One pane and a press on the status line: there is no other pane it could
    // have meant.
    expect(paneAtPoint(at(5, 23), GRID, [LEFT])?.id).toBe("%1");
  });

  it("returns nothing for a point outside the grid", () => {
    expect(paneAtPoint({ x: 0, y: 0 }, GRID, [LEFT, RIGHT])).toBeNull();
    expect(paneAtPoint({ x: 9999, y: 40 }, GRID, [LEFT, RIGHT])).toBeNull();
  });

  it("answers with the zoomed pane wherever the press landed", () => {
    // tmux keeps reporting the other panes at their unzoomed geometry while
    // one is zoomed, so the listing describes a layout that is not on screen.
    // A press in the right half is still a press on the zoomed pane.
    expect(paneAtPoint(at(60, 5), GRID, [LEFT, RIGHT], "%1")?.id).toBe("%1");
  });

  it("has nothing to say before the renderer has measured a cell", () => {
    const unmeasured = { ...GRID, cellWidth: 0, cellHeight: 0 };
    expect(paneAtPoint(at(5, 5), unmeasured, [LEFT])).toBeNull();
  });
});
