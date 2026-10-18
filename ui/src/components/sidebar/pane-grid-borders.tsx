import { useEffect, useRef, useState } from "react";
import type { PaneInfo, TerminalSize } from "@/protocol";
import {
  borderKey,
  borderSpan,
  borderValue,
  dragCell,
  resizeStep,
  type PaneBorder,
  type ResizeDirection,
} from "@/lib/pane-grid-layout";
import { cn } from "@/lib/utils";

/** Hit strip of a border in px, centred on the 2px gap between cells. */
const STRIP = 8;
/** How long a released border waits at its drop spot for tmux to report it there. */
const SETTLE_MS = 800;

type Drag = { key: string; cell: number; settling?: boolean };

interface Active {
  key: string;
  border: PaneBorder;
  owner: PaneInfo;
  element: HTMLElement;
  pointerId: number;
  /** Pointer along the drag axis at the start, in client px. */
  origin: number;
  /** Px of one column or row. */
  cellPx: number;
  /** Separator cell under the pointer. */
  target: number;
  /** Separator cell tmux has been asked for. */
  sent: number;
  frame: number | null;
}

/**
 * Resize borders of a pane grid.
 *
 * Every border with an owner gets an invisible 8px strip, a
 * `role="separator"` that pointer and keyboard both move. Tab does not stop
 * on it. A cell reaches the border on its side with Alt and an arrow key.
 * On the border, the arrows along its axis move it one column or row, Shift
 * five. Escape or Enter goes back to the cell. Alt and an arrow across the
 * border goes to the cell on that side.
 *
 * A drag moves the drawn border with the pointer in whole columns or rows.
 * `live` sends a `pane:resize` per animation frame when the amount changed.
 * Otherwise one resize goes on release. Escape during a live drag sends the
 * border back where it started.
 */
export function GridBorders({
  borders,
  panes,
  size,
  cells,
  live,
  hidden,
  onResize,
  onLeave,
}: {
  borders: PaneBorder[];
  panes: PaneInfo[];
  /** Grid size in px. */
  size: { width: number; height: number };
  /** Window size in columns and rows, the scale of the layout. */
  cells: TerminalSize;
  live: boolean;
  /** No strips while a cell drag runs. */
  hidden?: boolean;
  onResize: (pane: PaneInfo, direction: ResizeDirection, amount: number) => void;
  /** Focus leaves a border: back to its cell, or to the first pane on `side`. */
  onLeave: (border: PaneBorder, side?: "before" | "after") => void;
}) {
  const [drag, setDrag] = useState<Drag | null>(null);
  const active = useRef<Active | null>(null);
  const onResizeRef = useRef(onResize);
  onResizeRef.current = onResize;
  const liveRef = useRef(live);
  liveRef.current = live;

  const flush = (a: Active, final: boolean) => {
    setDrag((previous) =>
      previous?.key === a.key && previous.cell === a.target && !previous.settling
        ? previous
        : { key: a.key, cell: a.target },
    );
    if (!liveRef.current && !final) return;
    const step = resizeStep(a.border.orientation, a.sent, a.target);
    if (!step) return;
    a.sent = a.target;
    onResizeRef.current(a.owner, step.direction, step.amount);
  };

  const end = (commit: boolean) => {
    const a = active.current;
    if (!a) return;
    active.current = null;
    if (a.frame !== null) cancelAnimationFrame(a.frame);
    if (a.element.hasPointerCapture(a.pointerId)) a.element.releasePointerCapture(a.pointerId);
    if (commit) {
      flush(a, true);
      // Drawn at the drop spot until tmux reports the border there.
      setDrag(a.target === a.border.cell ? null : { key: a.key, cell: a.target, settling: true });
      return;
    }
    if (liveRef.current) {
      const back = resizeStep(a.border.orientation, a.sent, a.border.cell);
      if (back) onResizeRef.current(a.owner, back.direction, back.amount);
    }
    setDrag(null);
  };
  const endRef = useRef(end);
  endRef.current = end;

  const dragging = !!drag && !drag.settling;
  useEffect(() => {
    if (!dragging) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      endRef.current(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [dragging]);

  // A settled border shows where tmux put it.
  const settled = drag?.settling
    ? borders.find((border) => borderKey(border) === drag.key)
    : undefined;
  useEffect(() => {
    if (!drag?.settling) return;
    if (!settled || settled.cell === drag.cell) {
      setDrag(null);
      return;
    }
    const timer = window.setTimeout(() => setDrag(null), SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [drag, settled]);

  useEffect(
    () => () => {
      const a = active.current;
      if (a?.frame != null) cancelAnimationFrame(a.frame);
    },
    [],
  );

  if (!size.width || !size.height) return null;
  const byId = new Map(panes.map((pane) => [pane.id, pane]));
  // Named from the panes before it: "Border right of panes 0 and 1".
  const names = (ids: string[]) => {
    const indexes = ids.map((id) => byId.get(id)?.index ?? "?");
    if (indexes.length === 1) return `pane ${indexes[0]}`;
    return `panes ${indexes.slice(0, -1).join(", ")} and ${indexes.at(-1)}`;
  };

  return (
    <>
      {borders.map((border) => {
        const owner = border.owner ? byId.get(border.owner) : undefined;
        if (!owner) return null;
        const key = borderKey(border);
        const vertical = border.orientation === "vertical";
        const moving = drag?.key === key ? drag : null;
        const cell = moving ? moving.cell : border.cell;
        const value = borderValue({ ...border, cell });
        const span = borderSpan(border, cells);
        const along = vertical ? size.height : size.width;
        const from = span.start * along + (span.start > 0 ? STRIP / 2 : 0);
        const to = span.end * along - (span.end < 1 ? STRIP / 2 : 0);
        if (to - from < STRIP) return null;
        const at = (cell + 0.5) / (vertical ? cells.cols : cells.rows);
        const back = vertical ? "ArrowLeft" : "ArrowUp";
        const forward = vertical ? "ArrowRight" : "ArrowDown";

        return (
          <div
            key={key}
            role="separator"
            tabIndex={-1}
            data-border={key}
            aria-label={`Border ${vertical ? "right of" : "below"} ${names(border.before)}`}
            aria-orientation={border.orientation}
            aria-valuenow={value.now}
            aria-valuemin={value.min}
            aria-valuemax={value.max}
            aria-valuetext={`${value.now} ${vertical ? "columns" : "rows"}`}
            aria-keyshortcuts={`${back} ${forward} Shift+${back} Shift+${forward} Escape`}
            className={cn(
              "group/border absolute z-20 flex touch-none select-none items-center justify-center rounded-[2px]",
              "focus-visible:outline-2 focus-visible:outline-ring",
              vertical ? "cursor-col-resize" : "cursor-row-resize",
              hidden && "pointer-events-none invisible",
            )}
            style={
              vertical
                ? {
                    left: `calc(${at * 100}% - ${STRIP / 2}px)`,
                    width: STRIP,
                    top: from,
                    height: to - from,
                  }
                : {
                    top: `calc(${at * 100}% - ${STRIP / 2}px)`,
                    height: STRIP,
                    left: from,
                    width: to - from,
                  }
            }
            onPointerDown={(event) => {
              if (event.button !== 0 || active.current) return;
              event.preventDefault();
              event.stopPropagation();
              event.currentTarget.setPointerCapture(event.pointerId);
              active.current = {
                key,
                border,
                owner,
                element: event.currentTarget,
                pointerId: event.pointerId,
                origin: vertical ? event.clientX : event.clientY,
                cellPx: vertical ? size.width / cells.cols : size.height / cells.rows,
                target: border.cell,
                sent: border.cell,
                frame: null,
              };
              setDrag({ key, cell: border.cell });
            }}
            onPointerMove={(event) => {
              const a = active.current;
              if (!a || a.pointerId !== event.pointerId) return;
              const delta = (vertical ? event.clientX : event.clientY) - a.origin;
              a.target = dragCell(a.border, delta, a.cellPx);
              if (a.frame === null) {
                a.frame = requestAnimationFrame(() => {
                  a.frame = null;
                  if (active.current === a) flush(a, false);
                });
              }
            }}
            onPointerUp={(event) => {
              if (active.current?.pointerId === event.pointerId) end(true);
            }}
            onPointerCancel={(event) => {
              if (active.current?.pointerId === event.pointerId) end(false);
            }}
            onLostPointerCapture={(event) => {
              if (active.current?.pointerId === event.pointerId) end(true);
            }}
            onKeyDown={(event) => {
              if (event.ctrlKey || event.metaKey) return;
              if (event.altKey) {
                if (event.key !== back && event.key !== forward) return;
                event.preventDefault();
                onLeave(border, event.key === back ? "before" : "after");
                return;
              }
              if (event.key === back || event.key === forward) {
                event.preventDefault();
                const step = event.shiftKey ? 5 : 1;
                const next = Math.min(
                  border.max - 2,
                  Math.max(border.min + 1, border.cell + (event.key === forward ? step : -step)),
                );
                const resize = resizeStep(border.orientation, border.cell, next);
                if (resize) onResize(owner, resize.direction, resize.amount);
                return;
              }
              if (event.key === "Escape" || event.key === "Enter") {
                event.preventDefault();
                onLeave(border);
              }
            }}
          >
            <span
              aria-hidden
              className={cn(
                "pointer-events-none rounded-full bg-primary opacity-0 group-hover/border:opacity-60 group-focus-visible/border:opacity-100 forced-colors:bg-[Highlight]",
                vertical ? "h-full w-0.5" : "h-0.5 w-full",
                moving && "opacity-100 group-hover/border:opacity-100",
              )}
            />
          </div>
        );
      })}
    </>
  );
}
