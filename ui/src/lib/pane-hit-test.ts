import type { PaneInfo } from "@repo/protocol";

/**
 * Which pane is under a point on the screen.
 *
 * ## Why this can be done at all
 *
 * tmux composites server-side: the client receives one linear ANSI stream of
 * tmux's own rendering, and there is no per-pane DOM to hit-test. What there
 * *is* is `pane:list`, whose entries carry `position` and `dimensions` in
 * character cells of the same grid xterm is drawing. So a point becomes a cell
 * and a cell becomes a pane — arithmetic, not layout.
 *
 * That is also why this is a pure function taking a measured grid rather than
 * reading the DOM: the only DOM fact involved is where cell (0,0) sits and how
 * big a cell is, which the terminal handle already measures for the scroll
 * gesture.
 *
 * ## The zoom exception
 *
 * A zoomed window shows one pane at full size, but tmux keeps reporting every
 * *other* pane at its unzoomed geometry — they are still laid out, merely not
 * visible. Hit-testing that listing while zoomed would happily return a pane
 * that is nowhere on screen. So while something is zoomed, every point in the
 * window belongs to the pane that is filling it.
 */

export type GridGeometry = {
  /** Client-space position of the top-left corner of cell (0,0). */
  left: number;
  top: number;
  cellWidth: number;
  cellHeight: number;
  cols: number;
  rows: number;
};

export function paneAtPoint(
  point: { x: number; y: number },
  grid: GridGeometry,
  panes: PaneInfo[],
  zoomedPaneId?: string | null,
): PaneInfo | null {
  if (panes.length === 0) return null;
  if (grid.cellWidth <= 0 || grid.cellHeight <= 0) return null;

  if (zoomedPaneId) {
    return panes.find((p) => p.id === zoomedPaneId) ?? null;
  }

  const col = Math.floor((point.x - grid.left) / grid.cellWidth);
  const row = Math.floor((point.y - grid.top) / grid.cellHeight);
  if (col < 0 || row < 0 || col >= grid.cols || row >= grid.rows) return null;

  const hit = panes.find(
    (p) =>
      col >= p.position.x &&
      col < p.position.x + p.dimensions.cols &&
      row >= p.position.y &&
      row < p.position.y + p.dimensions.rows,
  );
  if (hit) return hit;

  /*
   * Nothing matched, which is ordinary rather than an error: the grid also
   * holds tmux's status line and the one-cell borders between panes, and
   * neither belongs to a pane. With a single pane the intent is never in
   * doubt, so answer it; with several, a guess would be a wrong menu on a
   * pane the user did not press.
   */
  return panes.length === 1 ? (panes[0] ?? null) : null;
}
