import type { PaneInfo, TerminalSize } from "@/protocol";
import { processPresentation, type PaneRect, type ProcessKind } from "./session-presentation";
import { shortenPath, tailPath } from "./tmux-labels";

/**
 * Geometry and labels for the pane grid in the session sidebar.
 *
 * Rects are normalized to 0..1 like `paneLayout`. Geometry is physical and
 * does not mirror in RTL, since it draws the screen tmux draws.
 */

/** A terminal cell in px. Glyphs are about twice as tall as they are wide. */
export const GRID_CELL = { width: 8, height: 16 } as const;
export const GRID_MIN_HEIGHT = 56;
export const GRID_MAX_HEIGHT = 128;
/** 200x50 at an 8x16 cell, a common full screen terminal. */
export const GRID_FALLBACK_ASPECT = 2;

/** Rounding slack for comparing normalized edges. */
const EPS = 1e-6;

/** Width over height of a window drawn at `GRID_CELL`. */
export function gridAspect(dimensions?: TerminalSize | null): number {
  if (!dimensions || dimensions.cols < 1 || dimensions.rows < 1) {
    return GRID_FALLBACK_ASPECT;
  }
  return (dimensions.cols * GRID_CELL.width) / (dimensions.rows * GRID_CELL.height);
}

/** Grid height in px for a given width, clamped so one window never takes the panel. */
export function gridHeight(width: number, dimensions?: TerminalSize | null): number {
  const height = width / gridAspect(dimensions);
  return Math.min(GRID_MAX_HEIGHT, Math.max(GRID_MIN_HEIGHT, height));
}

/** Space between cells in px. */
export const GRID_GAP = 2;
/**
 * Height of one stacked pane in a sidebar grid. 56 px fit the corner button
 * and a split handle above each other, see `splitHandles`. 2 more cover a
 * split tmux could not make even, such as 25 and 24 rows.
 */
export const GRID_ROW_HEIGHT = 58;

/**
 * Most panes stacked in one column of the window: 1 for panes side by side,
 * 2 for a 2x2 tile, 3 for three rows. Counted on `cellBoxes`, which tile
 * the grid without gaps, at the middle of every cell.
 */
export function stackDepth(rects: readonly PaneRect[]): number {
  const boxes = cellBoxes(rects);
  let depth = 0;
  for (const box of boxes) {
    const x = box.x + box.width / 2;
    const stacked = boxes.filter(
      (other) => other.x - EPS <= x && x < other.x + other.width - EPS,
    ).length;
    depth = Math.max(depth, stacked);
  }
  return depth;
}

/**
 * Height cap of a sidebar grid by its stack depth. Panes side by side need
 * one row of cells, not the window's full aspect, so a sparse window costs
 * less height than a dense one. Three or more stacked panes keep the cap.
 */
export function stackedMaxHeight(depth: number): number {
  const height = depth * GRID_ROW_HEIGHT + Math.max(0, depth - 1) * GRID_GAP;
  return Math.min(GRID_MAX_HEIGHT, Math.max(GRID_MIN_HEIGHT, height));
}

/** Window size from the root of a tmux `window_layout`, such as `81x24`. */
export function layoutSize(layout: string): TerminalSize | null {
  const match = /^(?:[0-9a-f]{4},)?(\d+)x(\d+),/.exec(layout);
  if (!match) return null;
  const cols = Number(match[1]);
  const rows = Number(match[2]);
  return cols > 0 && rows > 0 ? { cols, rows } : null;
}

/**
 * What a cell has room for.
 *
 * - `full`: icon, label, folder line and index badge.
 * - `label`: icon and label.
 * - `icon`: icon only.
 * - `box`: the box alone. Title and accessible name still carry the text.
 */
export type CellTier = "full" | "label" | "icon" | "box";

const TIERS: readonly [CellTier, number, number][] = [
  ["full", 96, 36],
  ["label", 48, 20],
  ["icon", 24, 18],
];

/** Width of one character of the 12 px chrome face, which is monospace. */
export const LABEL_CHAR_PX = 7.2;
/** Padding, icon and gap beside a cell label. */
export const LABEL_CHROME_PX = 30;
/**
 * Fewest characters a label shows before an ellipsis. "wo…" says less than
 * the icon does, so a cell that cannot fit this many shows its icon.
 */
export const LABEL_MIN_CHARS = 4;

/**
 * `chars` is the length of the text the label shows. With it, the label
 * tier needs room for the whole label or for `LABEL_MIN_CHARS` of it.
 */
export function cellTier(width: number, height: number, chars?: number): CellTier {
  for (const [tier, minWidth, minHeight] of TIERS) {
    if (width < minWidth || height < minHeight) continue;
    if (tier === "label" && chars !== undefined) {
      const room = Math.floor((width - LABEL_CHROME_PX) / LABEL_CHAR_PX);
      if (room < Math.min(chars, LABEL_MIN_CHARS)) continue;
    }
    return tier;
  }
  return "box";
}

/** Characters the first line of a cell shows: the last folder of a shell, else the label. */
export function cellLabelLength(text: PaneCellText): number {
  return text.kind === "terminal" ? splitPath(text.label)[1].length : text.label.length;
}

export interface PaneCellText {
  kind: ProcessKind;
  /** First line. The folder for a shell, the process for anything else. */
  label: string;
  /** Second line, the folder. Only for processes. A shell shows it as its label. */
  folder?: string;
}

/** A shell is known by where it is. Anything else by what runs. */
export function paneCellText(pane: Pick<PaneInfo, "command" | "path">): PaneCellText {
  const { label, kind } = processPresentation(pane.command);
  const folder = pane.path ? tailPath(pane.path) : undefined;
  if (kind === "terminal") return { kind, label: folder ?? label };
  return { kind, label, folder };
}

/**
 * A short path cut before its last segment, such as `["…/internal/", "hub"]`.
 * Cells truncate the head first, so the folder you are in stays readable.
 */
export function splitPath(path: string): [head: string, leaf: string] {
  const cut = path.lastIndexOf("/", path.length - 2);
  if (cut < 0 || path.length < 2) return ["", path];
  return [path.slice(0, cut + 1), path.slice(cut + 1)];
}

/** Accessible name and title of a cell, such as "Pane 1, shell in ~/workspace, focused". */
export function paneCellName(
  pane: Pick<PaneInfo, "index" | "command" | "path">,
  state: { focused?: boolean; zoomed?: boolean } = {},
): string {
  const { label, kind } = processPresentation(pane.command);
  const what = kind === "terminal" ? "shell" : label;
  const where = pane.path ? ` in ${shortenPath(pane.path)}` : "";
  return [
    `Pane ${pane.index}`,
    `${what}${where}`,
    ...(state.focused ? ["focused"] : []),
    ...(state.zoomed ? ["zoomed"] : []),
  ].join(", ");
}

/**
 * Rects grown over the separators between them, so cells tile the grid.
 *
 * tmux keeps one cell of separator between panes. Drawn as is, that gap
 * scales with the window and reads as 1px on a wide window and 4px on a
 * narrow one. Each edge moves to the middle of its separator instead, and
 * the grid draws its own fixed gap.
 */
export function cellBoxes(rects: readonly PaneRect[]): PaneRect[] {
  const rights = rects.map((rect) => rect.x + rect.width);
  const bottoms = rects.map((rect) => rect.y + rect.height);
  const lefts = rects.map((rect) => rect.x);
  const tops = rects.map((rect) => rect.y);

  const before = (edge: number, ends: number[]) => {
    if (edge <= EPS) return 0;
    const near = ends.filter((end) => end <= edge + EPS);
    return near.length ? (edge + Math.max(...near)) / 2 : edge;
  };
  const after = (edge: number, starts: number[]) => {
    if (edge >= 1 - EPS) return 1;
    const near = starts.filter((start) => start >= edge - EPS);
    return near.length ? (edge + Math.min(...near)) / 2 : edge;
  };

  return rects.map((rect, index) => {
    const x = before(rect.x, rights);
    const y = before(rect.y, bottoms);
    const right = after(rights[index]!, lefts);
    const bottom = after(bottoms[index]!, tops);
    return { id: rect.id, x, y, width: right - x, height: bottom - y };
  });
}

export type GridDirection = "left" | "right" | "up" | "down";

/**
 * The cell an arrow key moves to, or null at the window edge.
 *
 * Only cells entirely past the edge in that direction count. Among them,
 * cells that share a span with the current one win, then the closest edge,
 * then the closest center across the move, then reading order.
 */
export function nearestCell(
  rects: readonly PaneRect[],
  fromId: string,
  direction: GridDirection,
): string | null {
  const from = rects.find((rect) => rect.id === fromId);
  if (!from) return null;
  const horizontal = direction === "left" || direction === "right";
  const forward = direction === "right" || direction === "down";
  const center = (rect: PaneRect) => ({
    x: rect.x + rect.width / 2,
    y: rect.y + rect.height / 2,
  });
  const origin = center(from);

  let best: { id: string; score: number[] } | null = null;
  for (const rect of rects) {
    if (rect.id === from.id) continue;
    const gap = horizontal
      ? forward
        ? rect.x - (from.x + from.width)
        : from.x - (rect.x + rect.width)
      : forward
        ? rect.y - (from.y + from.height)
        : from.y - (rect.y + rect.height);
    if (gap < -EPS) continue;
    const overlap = horizontal
      ? Math.min(rect.y + rect.height, from.y + from.height) - Math.max(rect.y, from.y)
      : Math.min(rect.x + rect.width, from.x + from.width) - Math.max(rect.x, from.x);
    const c = center(rect);
    const across = horizontal ? Math.abs(c.y - origin.y) : Math.abs(c.x - origin.x);
    const score = [overlap > EPS ? 0 : 1, gap, across, rect.y, rect.x];
    if (!best || lessThan(score, best.score)) best = { id: rect.id, score };
  }
  return best?.id ?? null;
}

function lessThan(a: number[], b: number[]): boolean {
  for (let i = 0; i < a.length; i++) {
    const diff = a[i]! - b[i]!;
    if (Math.abs(diff) > EPS) return diff < 0;
  }
  return false;
}

/** One cell of a parsed tmux layout, in tmux cells. */
export type LayoutCell =
  | { type: "pane"; id: string; x: number; y: number; width: number; height: number }
  | {
      /** `leftright` is tmux `{}`, side by side. `topbottom` is `[]`, stacked. */
      type: "leftright" | "topbottom";
      x: number;
      y: number;
      width: number;
      height: number;
      cells: LayoutCell[];
    };

/** Parse a tmux `window_layout` into its tree. Null when it does not parse. */
export function parseLayout(layout: string): LayoutCell | null {
  const body = layout.replace(/^[0-9a-f]{4},/, "");
  const digits = /\d+/y;
  let at = 0;

  const fail = (): never => {
    throw new SyntaxError(`bad layout at ${at}`);
  };
  const number = () => {
    digits.lastIndex = at;
    const match = digits.exec(body);
    if (!match) return fail();
    at += match[0].length;
    return Number(match[0]);
  };
  const expect = (char: string) => {
    if (body[at] !== char) fail();
    at += 1;
  };
  const cell = (): LayoutCell => {
    const width = number();
    expect("x");
    const height = number();
    expect(",");
    const x = number();
    expect(",");
    const y = number();
    const open = body[at];
    if (open === "{" || open === "[") {
      at += 1;
      const cells = [cell()];
      while (body[at] === ",") {
        at += 1;
        cells.push(cell());
      }
      expect(open === "{" ? "}" : "]");
      return { type: open === "{" ? "leftright" : "topbottom", x, y, width, height, cells };
    }
    expect(",");
    return { type: "pane", id: `%${number()}`, x, y, width, height };
  };

  try {
    const root = cell();
    return at === body.length ? root : null;
  } catch {
    return null;
  }
}

function leaves(cell: LayoutCell): Extract<LayoutCell, { type: "pane" }>[] {
  return cell.type === "pane" ? [cell] : cell.cells.flatMap(leaves);
}

/**
 * The border between two panes, as `resize-pane` sees it.
 *
 * Normalized fields use the same space as `paneLayout`. Cell fields are in
 * tmux columns or rows, for `aria-valuenow` and for turning a px drag into
 * a resize amount.
 */
export interface PaneBorder {
  /** `vertical` divides left from right. `horizontal` divides top from bottom. */
  orientation: "vertical" | "horizontal";
  /** Middle of the separator: x for vertical, y for horizontal. */
  position: number;
  /** Extent along the border. */
  start: number;
  end: number;
  /** Separator column or row. */
  cell: number;
  /** First column or row of the cell before the border, and one past the cell after it. Bounds a drag. */
  min: number;
  max: number;
  /** Panes that touch the border on the left or on top, in reading order. */
  before: string[];
  /** Panes that touch it on the right or below. */
  after: string[];
  /**
   * Pane to target with `resize-pane`. R or D move this border right or down,
   * L or U move it back. Null when no pane moves exactly this border, which
   * tmux allows only by mouse drag.
   */
  owner: string | null;
}

/**
 * Every border between sibling cells of a tmux layout.
 *
 * Borders come from the layout tree, not from pixels. Two borders that line
 * up on screen but belong to different containers move separately in tmux,
 * so they stay separate here. Empty when the layout is missing, does not
 * parse, or names other panes than `panes`.
 *
 * tmux `layout_resize_pane` walks up from the pane to the first container of
 * the resize direction and moves the border after that child. The last child
 * moves the border before it instead. The owner is a pane that walk lands on
 * this border from.
 */
export function sharedBorders(
  layout: string,
  panes: readonly Pick<PaneInfo, "id">[],
): PaneBorder[] {
  const root = parseLayout(layout);
  if (!root) return [];
  const all = leaves(root);
  const ids = new Set(all.map((leaf) => leaf.id));
  if (all.length !== panes.length || panes.some((pane) => !ids.has(pane.id))) {
    return [];
  }
  const width = Math.max(1, ...all.map((leaf) => leaf.x + leaf.width));
  const height = Math.max(1, ...all.map((leaf) => leaf.y + leaf.height));

  // A pane whose walk up stops at `cell` for a container of `type`.
  const reach = (cell: LayoutCell, type: LayoutCell["type"]): string | null => {
    if (cell.type === "pane") return cell.id;
    if (cell.type === type) return null;
    for (const child of cell.cells) {
      const id = reach(child, type);
      if (id) return id;
    }
    return null;
  };

  const borders: PaneBorder[] = [];
  const visit = (cell: LayoutCell) => {
    if (cell.type === "pane") return;
    const vertical = cell.type === "leftright";
    cell.cells.forEach((first, index) => {
      const second = cell.cells[index + 1];
      if (!second) return;
      const firstEnd = vertical ? first.x + first.width : first.y + first.height;
      const secondStart = vertical ? second.x : second.y;
      const isLast = index + 1 === cell.cells.length - 1;
      const owner =
        reach(first, cell.type) ?? (isLast ? reach(second, cell.type) : null);
      const byReadingOrder = (
        a: Extract<LayoutCell, { type: "pane" }>,
        b: Extract<LayoutCell, { type: "pane" }>,
      ) => (vertical ? a.y - b.y : a.x - b.x);
      borders.push({
        orientation: vertical ? "vertical" : "horizontal",
        position: (firstEnd + 0.5) / (vertical ? width : height),
        start: vertical ? cell.y / height : cell.x / width,
        end: vertical
          ? (cell.y + cell.height) / height
          : (cell.x + cell.width) / width,
        cell: firstEnd,
        min: vertical ? first.x : first.y,
        max: vertical ? second.x + second.width : second.y + second.height,
        before: leaves(first)
          .filter((leaf) => (vertical ? leaf.x + leaf.width : leaf.y + leaf.height) === firstEnd)
          .sort(byReadingOrder)
          .map((leaf) => leaf.id),
        after: leaves(second)
          .filter((leaf) => (vertical ? leaf.x : leaf.y) === secondStart)
          .sort(byReadingOrder)
          .map((leaf) => leaf.id),
        owner,
      });
    });
    cell.cells.forEach(visit);
  };
  visit(root);
  return borders;
}

/**
 * Stable key of a border. A resize moves the border and keeps the panes on
 * both sides, so the key outlives the layout updates a drag causes.
 */
export function borderKey(border: Pick<PaneBorder, "orientation" | "before" | "after">): string {
  return `${border.orientation === "vertical" ? "v" : "h"}:${border.before.join(",")}|${border.after.join(",")}`;
}

/**
 * Extent of a border along its length, normalized like `cellBoxes`.
 *
 * `start` and `end` of a border are its container's edges. An inner edge
 * moves to the middle of the separator there, so the border reaches the
 * corner of the cells it runs along.
 */
export function borderSpan(
  border: Pick<PaneBorder, "orientation" | "start" | "end">,
  size: TerminalSize,
): { start: number; end: number } {
  const length = border.orientation === "vertical" ? size.rows : size.cols;
  const half = 0.5 / Math.max(1, length);
  return {
    start: border.start > EPS ? border.start - half : 0,
    end: border.end < 1 - EPS ? border.end + half : 1,
  };
}

/**
 * Separator column or row a drag lands on.
 *
 * `delta` is the drag in px and `cellPx` the px size of one column or row.
 * The result keeps at least one column or row on each side. tmux clamps
 * nested containers further by itself.
 */
export function dragCell(
  border: Pick<PaneBorder, "cell" | "min" | "max">,
  delta: number,
  cellPx: number,
): number {
  const moved = border.cell + (cellPx > 0 ? Math.round(delta / cellPx) : 0);
  return Math.min(border.max - 2, Math.max(border.min + 1, moved));
}

export type ResizeDirection = "U" | "D" | "L" | "R";

/** The `pane:resize` direction and amount that move a border from one cell to another. */
export function resizeStep(
  orientation: PaneBorder["orientation"],
  from: number,
  to: number,
): { direction: ResizeDirection; amount: number } | null {
  if (to === from) return null;
  const forward = to > from;
  const direction: ResizeDirection =
    orientation === "vertical" ? (forward ? "R" : "L") : forward ? "D" : "U";
  return { direction, amount: Math.abs(to - from) };
}

/**
 * Size of the cells before a border, for `aria-valuenow`, with its bounds.
 * One column or row on each side is the least tmux keeps.
 */
export function borderValue(border: Pick<PaneBorder, "cell" | "min" | "max">): {
  now: number;
  min: number;
  max: number;
} {
  return { now: border.cell - border.min, min: 1, max: Math.max(1, border.max - border.min - 2) };
}

/** Split handles and the corner menu button are 24px squares, the WCAG 2.5.8 minimum. */
export const HANDLE_SIZE = 24;
/**
 * Space between a handle and the cell edge. The border hit strip is 8px
 * wide over a 2px gap, so it reaches 3px into a cell.
 */
export const HANDLE_INSET = 4;

export interface HandleSpot {
  /** `h` splits right, on the right edge. `v` splits down, on the bottom edge. */
  direction: "h" | "v";
  /** Top left corner in px inside the cell. */
  x: number;
  y: number;
}

type Box = { x: number; y: number };

function overlaps(a: Box, b: Box): boolean {
  return (
    a.x < b.x + HANDLE_SIZE &&
    b.x < a.x + HANDLE_SIZE &&
    a.y < b.y + HANDLE_SIZE &&
    b.y < a.y + HANDLE_SIZE
  );
}

/**
 * Where the split handles of a cell go.
 *
 * The h handle sits on the right edge and the v handle on the bottom edge,
 * centred along it when there is room. Both stay inside the cell and clear
 * of the border strips, the corner menu button and each other. Each stays
 * in the half of the cell next to its edge, so a click in the middle of a
 * cell always selects and never splits. The handle along the longer side
 * goes first. A handle with no free spot is left out, and the cell menu
 * still has both splits.
 */
export function splitHandles(width: number, height: number, corner: boolean): HandleSpot[] {
  const size = HANDLE_SIZE;
  const inset = HANDLE_INSET;
  const taken: Box[] = corner ? [{ x: width - inset - size, y: inset }] : [];
  const fits = (box: Box, direction: "h" | "v") =>
    (direction === "h" ? box.x >= width / 2 : box.y >= height / 2) &&
    box.x >= inset &&
    box.y >= inset &&
    box.x + size <= width - inset &&
    box.y + size <= height - inset &&
    !taken.some((other) => overlaps(box, other));
  const clamp = (value: number, low: number, high: number) =>
    Math.round(Math.min(high, Math.max(low, value)));

  const right = width - inset - size;
  const bottom = height - inset - size;
  const candidates: Record<"h" | "v", Box[]> = {
    h: [
      { x: right, y: clamp(height / 2 - size / 2, inset, bottom) },
      { x: right, y: corner ? inset + size : inset },
      { x: right, y: bottom },
    ],
    v: [
      { x: clamp(width / 2 - size / 2, inset, right), y: bottom },
      { x: inset, y: bottom },
      { x: right - size - 2, y: bottom },
    ],
  };
  const order: ("h" | "v")[] = width >= height ? ["h", "v"] : ["v", "h"];
  const spots: HandleSpot[] = [];
  for (const direction of order) {
    const box = candidates[direction].find((spot) => fits(spot, direction));
    if (!box) continue;
    taken.push(box);
    spots.push({ direction, ...box });
  }
  return spots.sort((a, b) => (a.direction < b.direction ? -1 : 1));
}

/**
 * Tells the click that ends a cell drag from a select.
 *
 * A pointer released on the dragged cell is followed by a click on it, and
 * that click selects nothing. While the drag runs the pointer is captured,
 * so a drop always lands there. After Escape the release can land anywhere,
 * and a pointercancel or a cell that went away fires no click at all. Only a
 * release on the cell marks the click. A mark that no click took would eat
 * the next select, so a press clears it, and keyboard activation never
 * takes it: Enter, Space and assistive technology fire a click with
 * `detail` 0, a pointer release never does.
 */
export interface DragClickGuard {
  /** A pointer went down on a cell. */
  press: () => void;
  /** The pointer of a drag went up, dropped or after Escape. `onCell` when over the dragged cell. */
  release: (onCell: boolean) => void;
  /** A click on a cell, with its `detail`. True when it ends a drag and selects nothing. */
  click: (detail: number) => boolean;
}

export function dragClickGuard(): DragClickGuard {
  let mark = false;
  return {
    press: () => {
      mark = false;
    },
    release: (onCell) => {
      mark = onCell;
    },
    click: (detail) => {
      const swallow = mark && detail > 0;
      mark = false;
      return swallow;
    },
  };
}

/** Lines a peek shows. */
export const PEEK_LINES = 12;

/**
 * The last lines of a pane capture.
 *
 * A capture holds the whole visible pane, and the rows under a prompt are
 * blank. Those go first, so the peek ends on the last line with text.
 */
export function peekLines(content: string, count = PEEK_LINES): string[] {
  const lines = content.split("\n").map((line) => line.replace(/\s+$/, ""));
  let end = lines.length;
  while (end > 0 && lines[end - 1] === "") end--;
  return lines.slice(Math.max(0, end - count), end);
}

/**
 * The border on one side of a pane that a resize can move, or null.
 * Alt and an arrow key on a cell goes to it.
 */
export function borderBeside(
  borders: readonly PaneBorder[],
  paneId: string,
  direction: GridDirection,
): PaneBorder | null {
  const vertical = direction === "left" || direction === "right";
  const ahead = direction === "right" || direction === "down";
  return (
    borders.find(
      (border) =>
        border.owner !== null &&
        (border.orientation === "vertical") === vertical &&
        (ahead ? border.before : border.after).includes(paneId),
    ) ?? null
  );
}
