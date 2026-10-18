import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Ellipsis, Maximize2, Plus } from "lucide-react";
import type { PaneInfo, TerminalSize } from "@/protocol";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  GRID_GAP,
  GRID_MAX_HEIGHT,
  GRID_MIN_HEIGHT,
  borderBeside,
  borderKey,
  cellBoxes,
  dragClickGuard,
  cellLabelLength,
  cellTier,
  gridAspect,
  layoutSize,
  nearestCell,
  paneCellName,
  paneCellText,
  sharedBorders,
  splitHandles,
  splitPath,
  stackDepth,
  stackedMaxHeight,
  type CellTier,
  type GridDirection,
  type PaneBorder,
  type ResizeDirection,
} from "@/lib/pane-grid-layout";
import { paneLayout } from "@/lib/session-presentation";
import { cn } from "@/lib/utils";
import { GridBorders } from "./pane-grid-borders";
import { PanePeek } from "./pane-peek";
import { usePanePeek } from "./use-pane-peek";
import { ProcessIcon } from "./process-icon";
import { TreeMenuItem, type TreeAction } from "./tree-row";

/** Space between cells in px. tmux's own separator scales with the window. */
const GAP = GRID_GAP;
const EPS = 1e-6;
/** A cell drag starts once the pointer moved this far, so a click stays a click. */
const DRAG_SLOP_PX = 4;

const ARROWS: Partial<Record<string, GridDirection>> = {
  ArrowLeft: "left",
  ArrowRight: "right",
  ArrowUp: "up",
  ArrowDown: "down",
};

/** One step of a cell drag. */
export interface PaneDragEvent {
  pane: PaneInfo;
  /** `move` while the pointer moves, then one `drop` or `cancel`. Escape cancels. */
  phase: "move" | "drop" | "cancel";
  /** Pointer in client px. */
  x: number;
  y: number;
}

/** Grid actions a cell menu can offer. */
export interface PaneGridMenu {
  /**
   * Run this instead of focusing the cell when the menu closes. For an item
   * that moves the pane out of this grid, so focus lands where it went.
   */
  focusAfter: (run: () => void) => void;
  /** Open the peek and move focus into it. Key P. */
  peek?: () => void;
  /** Focus the first border of the pane that a resize moves. Keys Alt and an arrow. */
  resize?: () => void;
}

export interface PaneGridProps {
  /** tmux `window_layout`. The saved layout, so splits stay visible while zoomed. */
  layout: string;
  panes: PaneInfo[];
  /** Window size in cells, for the aspect. The layout root size is the fallback. */
  dimensions?: TerminalSize;
  /**
   * Height cap. A number is px, a string any CSS length such as
   * `min(45dvh, 24rem)`. Default 128, the sidebar cap.
   */
  maxHeight?: number | string;
  /** Active pane of this window. */
  focusId?: string | null;
  zoomedId?: string | null;
  /** The window is on screen in the attached session. Its focused pane is the one you type into. */
  active?: boolean;
  /** A switch to this pane is on the wire and not confirmed yet. */
  pendingId?: string | null;
  /** `settings.showPaneIndexes`. */
  showIndex?: boolean;
  /** Group label, such as "Panes of window 0 top". */
  label: string;
  onSelect: (pane: PaneInfo) => void;
  /** Double click. */
  onZoom?: (pane: PaneInfo) => void;
  /** `+` handles on the right edge (h) and bottom edge (v) of a hovered cell. */
  onSplit?: (pane: PaneInfo, direction: "h" | "v") => void;
  /**
   * Border drag and border keys. `pane` is the border's owner, the pane
   * tmux `resize-pane` moves exactly that border for. Borders are hidden
   * while the window is zoomed, since a resize unzooms it.
   */
  onResize?: (pane: PaneInfo, direction: ResizeDirection, amount: number) => void;
  /**
   * Send a border drag while it moves, one `onResize` per animation frame.
   * False sends one on release, for a session that must attach first.
   * Default true.
   */
  liveResize?: boolean;
  /** Cell drag with mouse or pen. The caller finds and lights the drop target. */
  onDrag?: (event: PaneDragEvent) => void;
  /** Cell drawn as the drop target of a drag. */
  dropTargetId?: string | null;
  /** Read-only previews work without attaching this session. */
  preview?: { machineId: string; session: string };
  /** Delete key. The caller asks before it kills. */
  onKill?: (pane: PaneInfo) => void;
  /** Right click, the context menu key, Shift+F10 and the corner button. */
  menu?: (pane: PaneInfo, grid: PaneGridMenu) => TreeAction[];
  /**
   * `sidebar` cells join the session tree: they carry `data-tree-row` keys
   * `p:<paneId>` and take their tab stop from `tabStopId`. `card` grids keep
   * their own tab stop.
   */
  size?: "sidebar" | "card";
  /**
   * Pane whose cell holds the tree's one tab stop. Null when the stop is on
   * another row. Undefined lets the grid pick: last focused, active, first.
   */
  tabStopId?: string | null;
  onFocusPane?: (pane: PaneInfo) => void;
}

/**
 * One window drawn as tmux draws it, every pane a button.
 *
 * Geometry comes from the layout and is physical. It does not mirror in
 * RTL, and neither do the arrow keys that walk it. Cell content steps down
 * with the cell's size. The title and the accessible name always carry
 * the full text.
 *
 * Keys on a cell: arrows move by geometry, Home and End go to the first and
 * last pane, Enter selects, Delete kills, the context menu key or Shift+F10
 * opens the menu, P peeks, Alt and an arrow goes to the border on that side.
 *
 * Cells smaller than 24px stay that size. The grid is a map and its sizes
 * are the information. A bigger hit area would cover the neighbour 2px
 * away. Every cell still has its full name and is reached by the arrows.
 */
export function PaneGrid({
  layout,
  panes,
  dimensions,
  maxHeight = GRID_MAX_HEIGHT,
  focusId,
  zoomedId,
  active = false,
  pendingId,
  showIndex = true,
  label,
  onSelect,
  onZoom,
  onSplit,
  onResize,
  liveResize = true,
  onDrag,
  dropTargetId,
  preview,
  onKill,
  menu,
  size = "sidebar",
  tabStopId,
  onFocusPane,
}: PaneGridProps) {
  const ref = useRef<HTMLDivElement>(null);
  const box = useElementSize(ref);
  // Open menu. `at` is the pointer for a right click, in px inside the
  // cell. Without it the menu hangs off the corner button.
  const [openMenu, setOpenMenu] = useState<{
    id: string;
    at: { x: number; y: number } | null;
  } | null>(null);
  const [lastFocused, setLastFocused] = useState<string | null>(null);
  // Runs instead of focusing the cell when the menu closes, for a menu item
  // that moves focus somewhere else.
  const afterMenu = useRef<(() => void) | null>(null);
  // Cell a border was entered from, for Escape on the border.
  const borderOrigin = useRef<string | null>(null);
  const peek = usePanePeek(!!preview);

  const rects = useMemo(() => paneLayout(layout, panes), [layout, panes]);
  // The sidebar caps a sparse window lower, so panes side by side cost one
  // row of cells. Cards keep the aspect, so a row of them lines up.
  const depth = useMemo(() => stackDepth(rects), [rects]);
  const cap =
    size === "sidebar" && typeof maxHeight === "number"
      ? Math.min(maxHeight, stackedMaxHeight(depth))
      : maxHeight;
  const boxes = useMemo(() => new Map(cellBoxes(rects).map((cell) => [cell.id, cell])), [rects]);
  // DOM order is index order, so the tree walks cells the way tmux counts them.
  const ordered = useMemo(() => [...panes].sort((a, b) => a.index - b.index), [panes]);
  const resizable = !!onResize;
  const cells = useMemo(() => layoutSize(layout), [layout]);
  const borders = useMemo(
    () => (resizable && cells ? sharedBorders(layout, panes) : []),
    [resizable, cells, layout, panes],
  );
  // A resize unzooms the window. While zoomed, the borders rest.
  const liveBorders = zoomedId ? [] : borders;

  const has = (id: string | null | undefined): id is string =>
    !!id && ordered.some((pane) => pane.id === id);
  const stop =
    tabStopId !== undefined
      ? tabStopId
      : has(lastFocused)
        ? lastFocused
        : has(focusId)
          ? focusId
          : (ordered[0]?.id ?? null);

  const focusCell = (id: string) =>
    ref.current?.querySelector<HTMLElement>(`[data-pane-cell="${CSS.escape(id)}"]`)?.focus();

  const focusBorder = (border: PaneBorder, from: string) => {
    borderOrigin.current = from;
    ref.current
      ?.querySelector<HTMLElement>(`[data-border="${CSS.escape(borderKey(border))}"]`)
      ?.focus();
  };

  /** First border of a pane a resize can move: right, bottom, left, top. */
  const firstBorder = (paneId: string) =>
    (["right", "down", "left", "up"] as const)
      .map((direction) => borderBeside(liveBorders, paneId, direction))
      .find((border) => border !== null) ?? null;

  /** Focus the tree row before or after this grid. False outside a tree. */
  const leave = (from: HTMLElement, step: -1 | 1) => {
    const tree = from.closest("[data-tree]");
    const grid = ref.current;
    if (!tree || !grid) return false;
    const rows = Array.from(tree.querySelectorAll<HTMLElement>("[data-tree-row]"));
    const own = rows.filter((row) => grid.contains(row));
    if (!own.length) return false;
    const index = step < 0 ? rows.indexOf(own[0]!) - 1 : rows.indexOf(own[own.length - 1]!) + 1;
    const target = rows[index];
    target?.focus();
    return !!target;
  };

  // Cell drag. Mouse and pen only: a touch on the grid scrolls the sidebar,
  // and a long press peeks.
  const drag = useRef<{
    pane: PaneInfo;
    pointerId: number;
    x: number;
    y: number;
    active: boolean;
    /** Escape ended the drag. The press is followed to its release. */
    cancelled: boolean;
    element: HTMLElement;
    /** Removes the window listeners of this press. */
    stop: () => void;
  } | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  // The click that ends a drag is not a select.
  const [clicks] = useState(dragClickGuard);
  const onDragRef = useRef(onDrag);
  onDragRef.current = onDrag;

  /**
   * End the drag. `held` keeps following the press after Escape, since its
   * release can still land on the cell and click it.
   */
  const endDrag = (phase: "drop" | "cancel", x: number, y: number, held = false) => {
    const current = drag.current;
    if (!current) return;
    const wasDragging = current.active;
    if (held) {
      if (!wasDragging) return;
      current.active = false;
      current.cancelled = true;
    } else {
      drag.current = null;
      current.stop();
    }
    if (current.element.hasPointerCapture(current.pointerId)) {
      current.element.releasePointerCapture(current.pointerId);
    }
    if (!wasDragging) return;
    setDragging(null);
    onDragRef.current?.({ pane: current.pane, phase, x, y });
  };
  const endDragRef = useRef(endDrag);
  endDragRef.current = endDrag;

  useEffect(() => {
    if (!dragging) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      endDragRef.current("cancel", 0, 0, true);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [dragging]);

  // A drag the pane under it went away from ends there.
  useEffect(() => {
    if (dragging && !panes.some((pane) => pane.id === dragging)) {
      endDragRef.current("cancel", 0, 0);
    }
  }, [dragging, panes]);

  /**
   * Follow a press on a cell from the window. The first move can leave the
   * cell before the drag starts, and the cell would never hear of it.
   */
  const startPress = (event: React.PointerEvent<HTMLElement>, pane: PaneInfo) => {
    drag.current?.stop();
    const element = event.currentTarget;
    const pointerId = event.pointerId;
    const move = (e: PointerEvent) => {
      const current = drag.current;
      if (!current || e.pointerId !== pointerId || current.cancelled) return;
      if (!current.active) {
        if (Math.hypot(e.clientX - current.x, e.clientY - current.y) < DRAG_SLOP_PX) return;
        current.active = true;
        // Keeps hover and the cursor on the cell while the pointer travels.
        element.setPointerCapture(pointerId);
        setDragging(pane.id);
        peek.close();
      }
      onDragRef.current?.({ pane, phase: "move", x: e.clientX, y: e.clientY });
    };
    const up = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) return;
      const current = drag.current;
      // A release on the cell clicks it. Captured, a drop always does.
      if (current?.active || current?.cancelled) {
        clicks.release(e.target instanceof Node && element.contains(e.target));
      }
      if (current?.active) endDragRef.current("drop", e.clientX, e.clientY);
      else {
        current?.stop();
        drag.current = null;
      }
    };
    const cancel = (e: PointerEvent) => {
      if (e.pointerId === pointerId) endDragRef.current("cancel", e.clientX, e.clientY);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    drag.current = {
      pane,
      pointerId,
      x: event.clientX,
      y: event.clientY,
      active: false,
      cancelled: false,
      element,
      stop: () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", cancel);
      },
    };
  };
  useEffect(() => () => drag.current?.stop(), []);

  const onKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, pane: PaneInfo) => {
    const direction = ARROWS[event.key];
    if (event.altKey && direction && resizable && !event.ctrlKey && !event.metaKey) {
      // Alt and an arrow is also history back and forward. Taken here in
      // every case, so a cell without a border there does not leave the page.
      event.preventDefault();
      const border = borderBeside(liveBorders, pane.id, direction);
      if (border) focusBorder(border, pane.id);
      return;
    }
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (direction) {
      // Handled here in every case, so the tree does not also move.
      event.preventDefault();
      const next = nearestCell(rects, pane.id, direction);
      if (next) focusCell(next);
      else if (direction === "up" || direction === "left") leave(event.currentTarget, -1);
      else if (direction === "down") leave(event.currentTarget, 1);
      return;
    }
    switch (event.key) {
      case "Home":
      case "End": {
        const target = event.key === "Home" ? ordered[0] : ordered[ordered.length - 1];
        // Already at that end of the grid: the tree takes the key.
        if (!target || target.id === pane.id) return;
        event.preventDefault();
        focusCell(target.id);
        return;
      }
      case "p":
      case "P":
        if (!peek.enabled || event.shiftKey) return;
        event.preventDefault();
        peek.toggleKey(pane, event.currentTarget);
        return;
      case "Delete":
        if (!onKill) return;
        event.preventDefault();
        onKill(pane);
        return;
      case "ContextMenu":
        if (!menu) return;
        event.preventDefault();
        peek.close();
        setOpenMenu({ id: pane.id, at: null });
        return;
      case "F10":
        if (!event.shiftKey || !menu) return;
        event.preventDefault();
        peek.close();
        setOpenMenu({ id: pane.id, at: null });
        return;
    }
  };

  const gridMenu = (pane: PaneInfo): PaneGridMenu => ({
    focusAfter: (run) => {
      afterMenu.current = run;
    },
    peek: peek.enabled
      ? () => {
          afterMenu.current = () => {
            const cell = ref.current?.querySelector<HTMLElement>(
              `[data-pane-cell="${CSS.escape(pane.id)}"]`,
            );
            if (cell) peek.open(pane, "key", cell);
          };
        }
      : undefined,
    resize: firstBorder(pane.id)
      ? () => {
          afterMenu.current = () => {
            const border = firstBorder(pane.id);
            if (border) focusBorder(border, pane.id);
          };
        }
      : undefined,
  });

  return (
    <div
      ref={ref}
      role="group"
      aria-label={label}
      className="relative w-full select-none"
      style={{
        aspectRatio: gridAspect(dimensions ?? layoutSize(layout)),
        minHeight: GRID_MIN_HEIGHT,
        maxHeight: cap,
      }}
    >
      {ordered.map((pane) => {
        const cell = boxes.get(pane.id);
        if (!cell) return null;
        // Half the gap on every inner edge. Outer edges sit on the box.
        const start = cell.x > EPS ? GAP / 2 : 0;
        const end = cell.x + cell.width < 1 - EPS ? GAP / 2 : 0;
        const top = cell.y > EPS ? GAP / 2 : 0;
        const bottom = cell.y + cell.height < 1 - EPS ? GAP / 2 : 0;
        const width = cell.width * box.width - start - end;
        const height = cell.height * box.height - top - bottom;
        const tier = cellTier(width, height, cellLabelLength(paneCellText(pane)));
        const focused = pane.id === focusId;
        const zoomed = pane.id === zoomedId;
        // Behind the zoomed pane. tmux does not draw it, so it is outlined.
        const hidden = !!zoomedId && !zoomed;
        const name = paneCellName(pane, { focused, zoomed });
        const menuOpen = openMenu?.id === pane.id;
        const menuAt = menuOpen ? openMenu.at : null;
        // The corner button is 24px with 4px of room around it. On touch it
        // always shows, and a roomy cell grows its target to 44px into the
        // cell, never past the cell edge.
        const trigger = tier === "full" || (tier === "label" && height >= 32);
        const roomy = width >= 52 && height >= 52;
        const handles = onSplit && !dragging ? splitHandles(width, height, !!menu && trigger) : [];
        const shortcuts = [
          peek.enabled && "P",
          liveBorders.length > 0 && "Alt+ArrowLeft Alt+ArrowRight Alt+ArrowUp Alt+ArrowDown",
        ].filter(Boolean);

        return (
          <div
            key={pane.id}
            data-cell={pane.id}
            className={cn(
              "group/cell absolute rounded-[4px] transition-[background-color,opacity] duration-150 has-[:focus-visible]:z-10 motion-reduce:transition-none",
              // Cells keep their shape where forced colors drop backgrounds.
              "forced-colors:outline forced-colors:outline-1 forced-colors:-outline-offset-1",
              // Foreground tints, not the muted surface. That surface sits at
              // about 1.05:1 on the panel, and the cells vanished. The focus
              // mark is an outline, which forced colors keep. Off screen it
              // is the muted line the zoom hidden cells use dashed: at least
              // 3.49:1 on the cell in both schemes, where `line-strong` was
              // 1.29:1.
              focused
                ? active
                  ? "bg-primary/15 text-foreground outline outline-1 -outline-offset-1 outline-primary hover:bg-primary/20 forced-colors:outline-2 forced-colors:outline-[Highlight]"
                  : "bg-foreground/10 text-foreground outline outline-1 -outline-offset-1 outline-muted-foreground/80 hover:bg-foreground/15 forced-colors:outline-2"
                : hidden
                  ? "text-muted-foreground outline outline-1 -outline-offset-1 outline-dashed outline-muted-foreground/80 hover:bg-foreground/5 hover:text-foreground"
                  : "bg-foreground/10 text-muted-foreground hover:bg-foreground/15 hover:text-foreground",
              pendingId === pane.id && "opacity-70",
              dragging === pane.id && "opacity-50",
              dropTargetId === pane.id &&
                "bg-primary/20 outline-2 outline-solid outline-primary forced-colors:outline-[Highlight]",
            )}
            style={{
              left: `calc(${cell.x * 100}% + ${start}px)`,
              top: `calc(${cell.y * 100}% + ${top}px)`,
              width: `calc(${cell.width * 100}% - ${start + end}px)`,
              height: `calc(${cell.height * 100}% - ${top + bottom}px)`,
            }}
            {...peek.hover(pane)}
            onContextMenu={
              menu || peek.enabled
                ? (event) => {
                    if (peek.contextMenu(event, pane) || !menu) return;
                    event.preventDefault();
                    // The context menu key and Shift+F10 opened it already.
                    if (openMenu?.id === pane.id) return;
                    peek.close();
                    // Opened from the corner, the menu would cover the
                    // pointer, and the release of the right button would pick
                    // the item under it. At the pointer it opens beside it.
                    const bounds = event.currentTarget.getBoundingClientRect();
                    setOpenMenu({
                      id: pane.id,
                      at:
                        event.button === 2
                          ? { x: event.clientX - bounds.left, y: event.clientY - bounds.top }
                          : null,
                    });
                  }
                : undefined
            }
          >
            <button
              type="button"
              data-tree-row={size === "sidebar" ? `p:${pane.id}` : undefined}
              data-pane-cell={pane.id}
              tabIndex={stop === pane.id ? 0 : -1}
              aria-label={name}
              aria-current={focused && active ? "true" : undefined}
              aria-keyshortcuts={shortcuts.length ? shortcuts.join(" ") : undefined}
              // The peek header names the pane, and a native tooltip would sit on top of it.
              title={peek.enabled ? undefined : name}
              onFocus={() => {
                setLastFocused(pane.id);
                onFocusPane?.(pane);
              }}
              onPointerDown={(event) => {
                clicks.press();
                peek.pointerDown(event, pane);
                if (
                  !onDrag ||
                  event.pointerType === "touch" ||
                  event.button !== 0 ||
                  event.altKey ||
                  event.ctrlKey ||
                  event.metaKey ||
                  event.shiftKey
                ) {
                  return;
                }
                startPress(event, pane);
              }}
              onPointerMove={peek.pointerMove}
              onPointerUp={peek.pointerUp}
              onPointerCancel={peek.pointerUp}
              onClick={(event) => {
                if (clicks.click(event.detail) || peek.consumeClick()) return;
                onSelect(pane);
              }}
              onDoubleClick={onZoom ? () => onZoom(pane) : undefined}
              onKeyDown={(event) => onKeyDown(event, pane)}
              className={cn(
                "absolute inset-0 flex min-w-0 touch-manipulation overflow-hidden rounded-[4px] text-start [-webkit-touch-callout:none]",
                "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
                tier === "icon" ? "items-center justify-center" : "items-start",
                dragging === pane.id && "cursor-grabbing",
              )}
            >
              <CellContent
                pane={pane}
                tier={tier}
                focused={focused}
                zoomed={zoomed}
                showIndex={showIndex}
                compact={height < 28}
                cornerButton={!!menu && trigger}
              />
            </button>
            {handles.map((spot) => (
              <button
                key={spot.direction}
                type="button"
                tabIndex={-1}
                aria-label={`Split pane ${pane.index} ${spot.direction === "h" ? "right" : "down"}`}
                title={spot.direction === "h" ? "Split right" : "Split down"}
                onClick={() => {
                  peek.close();
                  onSplit?.(pane, spot.direction);
                }}
                className={cn(
                  "group/handle pointer-events-none absolute z-10 flex h-6 w-6 items-center justify-center rounded-full opacity-0",
                  // Hover only. Touch splits from the menu, and the corner
                  // button's touch target would meet the right handle.
                  "group-hover/cell:pointer-events-auto group-hover/cell:opacity-100 [@media(hover:none),(pointer:coarse)]:hidden",
                  spot.direction === "h" ? "peer/h" : "peer/v",
                )}
                style={{ left: spot.x, top: spot.y }}
              >
                <span className="flex h-4 w-4 items-center justify-center rounded-full border border-line-strong bg-background text-foreground transition-colors duration-150 group-hover/handle:border-primary group-hover/handle:bg-primary group-hover/handle:text-primary-foreground motion-reduce:transition-none">
                  <Plus className="h-3 w-3" aria-hidden />
                </span>
              </button>
            ))}
            {handles.map((spot) => (
              // Where the new pane goes, while its handle is hovered.
              <span
                key={`preview-${spot.direction}`}
                aria-hidden
                className={cn(
                  "pointer-events-none absolute hidden border-dashed border-primary bg-primary/10",
                  spot.direction === "h"
                    ? "inset-y-0 right-0 w-1/2 rounded-r-[4px] border-l peer-hover/h:block"
                    : "inset-x-0 bottom-0 h-1/2 rounded-b-[4px] border-t peer-hover/v:block",
                )}
              />
            ))}
            {menu && (
              <DropdownMenu
                open={menuOpen}
                onOpenChange={(open) => {
                  if (open) peek.close();
                  setOpenMenu(open ? { id: pane.id, at: null } : null);
                }}
              >
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    tabIndex={-1}
                    aria-label={`Actions for pane ${pane.index}`}
                    title="More actions"
                    className={cn(
                      "absolute end-1 top-1 z-10 flex h-6 w-6 items-center justify-center rounded-[3px] bg-background text-muted-foreground opacity-0 hover:text-foreground",
                      trigger && !dragging
                        ? "group-hover/cell:opacity-100 group-has-[:focus-visible]/cell:opacity-100 [@media(hover:none),(pointer:coarse)]:opacity-100"
                        : "pointer-events-none",
                      trigger &&
                        !dragging &&
                        roomy &&
                        "[@media(hover:none),(pointer:coarse)]:after:absolute [@media(hover:none),(pointer:coarse)]:after:-top-1 [@media(hover:none),(pointer:coarse)]:after:-end-1 [@media(hover:none),(pointer:coarse)]:after:-bottom-4 [@media(hover:none),(pointer:coarse)]:after:-start-4",
                      trigger && menuOpen && !menuAt && "opacity-100",
                    )}
                    // A zero size anchor at the pointer while a right click
                    // menu is open.
                    style={
                      menuAt
                        ? { left: menuAt.x, top: menuAt.y, right: "auto", width: 0, height: 0 }
                        : undefined
                    }
                  >
                    <Ellipsis className="h-3.5 w-3.5" aria-hidden />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  align={menuAt ? "start" : "end"}
                  // Portalled out of the sidebar, so it does not inherit the face.
                  className="min-w-48 font-chrome text-[13px]"
                  // Back to the cell, not the corner button, unless the item
                  // picked moves focus on its own.
                  onCloseAutoFocus={(event) => {
                    event.preventDefault();
                    const next = afterMenu.current;
                    afterMenu.current = null;
                    if (next) next();
                    else focusCell(pane.id);
                  }}
                >
                  {menuOpen &&
                    menu(pane, gridMenu(pane)).map((action) => (
                      <TreeMenuItem key={action.label} action={action} />
                    ))}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        );
      })}
      {resizable && cells && (
        <GridBorders
          borders={liveBorders}
          panes={panes}
          size={box}
          cells={cells}
          live={liveResize}
          hidden={!!dragging}
          onResize={(pane, direction, amount) => onResize?.(pane, direction, amount)}
          onLeave={(border, side) => {
            const origin = borderOrigin.current;
            const ids = side ? border[side] : [];
            const target =
              ids[0] ??
              (origin && [...border.before, ...border.after].includes(origin)
                ? origin
                : border.before[0]);
            if (target) focusCell(target);
          }}
        />
      )}
      {peek.enabled && (
        <PanePeek
          peek={peek.peek}
          scope={preview!}
          onClose={peek.close}
          onPointerEnter={peek.keepOpen}
          onPointerLeave={peek.scheduleClose}
          returnFocus={focusCell}
        />
      )}
    </div>
  );
}

function CellContent({
  pane,
  tier,
  focused,
  zoomed,
  showIndex,
  compact,
  cornerButton,
}: {
  pane: PaneInfo;
  tier: CellTier;
  focused: boolean;
  zoomed: boolean;
  showIndex: boolean;
  compact: boolean;
  /** The menu button takes the corner on hover and focus. */
  cornerButton: boolean;
}) {
  if (tier === "box") return null;
  const icon = <ProcessIcon command={pane.command} active={focused} className="h-3.5 w-3.5" />;
  if (tier === "icon") {
    return zoomed ? <Maximize2 className="h-3.5 w-3.5" aria-hidden /> : icon;
  }
  const text = paneCellText(pane);
  const line = (
    <span className="flex min-w-0 items-center gap-1">
      {icon}
      {text.kind === "terminal" && pane.path ? (
        <PathText path={text.label} className="text-xs leading-4" />
      ) : (
        <span className="min-w-0 truncate text-xs leading-4">{text.label}</span>
      )}
      {tier === "label" && zoomed && <Maximize2 className="h-3 w-3 shrink-0" aria-hidden />}
    </span>
  );
  if (tier === "label") {
    return (
      <span
        className={cn(
          "flex min-w-0 flex-1 px-1.5",
          compact ? "pt-0.5" : "pt-1",
          cornerButton && "[@media(hover:none),(pointer:coarse)]:pe-8",
        )}
      >
        {line}
      </span>
    );
  }
  const corner = showIndex || zoomed;
  return (
    <>
      <span
        className={cn(
          "flex min-w-0 flex-1 flex-col ps-1.5 pt-1",
          zoomed && showIndex ? "pe-10" : corner ? "pe-7" : "pe-1.5",
          // On touch the corner button stays, and the badge moves beside it.
          cornerButton &&
            (zoomed && showIndex
              ? "[@media(hover:none),(pointer:coarse)]:pe-16"
              : corner
                ? "[@media(hover:none),(pointer:coarse)]:pe-12"
                : "[@media(hover:none),(pointer:coarse)]:pe-8"),
        )}
      >
        {line}
        {text.folder && (
          <PathText
            path={text.folder}
            className="ps-[18px] text-[11px] leading-4 text-muted-foreground"
          />
        )}
      </span>
      {corner && (
        <span
          aria-hidden
          className={cn(
            "absolute end-1.5 top-1 flex items-center gap-1 text-xs leading-4 tabular-nums text-muted-foreground",
            cornerButton &&
              "group-hover/cell:invisible group-has-[:focus-visible]/cell:invisible [@media(hover:none),(pointer:coarse)]:end-8 [@media(hover:none),(pointer:coarse)]:visible",
          )}
        >
          {zoomed && <Maximize2 className="h-3 w-3" />}
          {showIndex && pane.index}
        </span>
      )}
    </>
  );
}

/**
 * A path that keeps its last segment.
 *
 * The whole path when it fits, else the last segment alone. Never a stray
 * piece of the head. The two parts wrap in reverse, so the head is the
 * part that drops to the hidden second line. Paths read left to right in
 * every locale.
 */
function PathText({ path, className }: { path: string; className?: string }) {
  const [head, leaf] = splitPath(path);
  return (
    <span
      dir="ltr"
      className={cn(
        "flex h-4 min-w-0 flex-row-reverse flex-wrap justify-end overflow-hidden whitespace-nowrap",
        className,
      )}
    >
      <span className="min-w-0 truncate">{leaf}</span>
      {head && <span className="shrink-0">{head}</span>}
    </span>
  );
}

/**
 * Rounded px size of an element.
 *
 * Read once before paint so the first frame has the right content, then
 * kept current by a ResizeObserver. Nothing here writes layout, so there
 * is no read and write loop.
 */
function useElementSize(ref: React.RefObject<HTMLElement | null>) {
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const apply = (width: number, height: number) => {
      const next = { width: Math.round(width), height: Math.round(height) };
      setSize((previous) =>
        previous.width === next.width && previous.height === next.height ? previous : next,
      );
    };
    const initial = element.getBoundingClientRect();
    apply(initial.width, initial.height);
    const observer = new ResizeObserver(([entry]) => {
      if (entry) apply(entry.contentRect.width, entry.contentRect.height);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return size;
}
