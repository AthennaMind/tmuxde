import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import { Loader2 } from "lucide-react";
import type { PaneInfo } from "@/protocol";
import { paneCellName, peekLines } from "@/lib/pane-grid-layout";
import { useUiStore } from "@/stores/ui-store";
import { ProcessIcon } from "./process-icon";

/** Hover this long before a peek opens. A long press waits as long. */
export const PEEK_DELAY_MS = 500;
/** Time for the pointer to cross from the cell into the popover. */
const PEEK_CLOSE_MS = 150;
/** A touch that moves further than this scrolls, it does not press. */
const PRESS_SLOP_PX = 8;

/** How the peek opened. It decides focus and what closes it. */
export type PeekVia = "hover" | "touch" | "key";

export interface Peek {
  pane: PaneInfo;
  via: PeekVia;
  anchor: HTMLElement;
}

/**
 * State and gestures of the peek popover of one grid.
 *
 * The text comes through the same path as the copy mode overlay: a
 * `pane:capture`, whose `pane:captured` reply lands in `ui-store` as
 * `capturedPaneId` and `capturedContent`. While the overlay is open it owns
 * that slot, so no peek opens. A peek clears the slot when it closes, and a
 * reply that lands after the peek closed is cleared too, so the overlay
 * never opens on a pane it did not ask for. "Copy contents" routes its reply
 * through `machine-store` and never reaches this slot.
 */
export function usePanePeek(onPeek: ((pane: PaneInfo) => void) | undefined) {
  const [peek, setPeek] = useState<Peek | null>(null);
  const peekRef = useRef(peek);
  peekRef.current = peek;
  const timer = useRef<number | null>(null);
  const press = useRef<{ x: number; y: number; timer: number } | null>(null);
  // A long press opened the peek. The click that follows the lift is not a select.
  const pressed = useRef(false);
  const lastPointer = useRef<string>("mouse");
  // Panes whose reply was still on the wire when their peek closed.
  const stale = useRef(new Set<string>());

  const clearTimer = useCallback(() => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  }, []);
  const cancelPress = useCallback(() => {
    if (press.current) window.clearTimeout(press.current.timer);
    press.current = null;
  }, []);

  const close = useCallback(() => {
    clearTimer();
    cancelPress();
    const current = peekRef.current;
    if (!current) return;
    peekRef.current = null;
    setPeek(null);
    const ui = useUiStore.getState();
    if (ui.copyModeOpen || ui.capturedPaneId !== current.pane.id) return;
    if (ui.capturedContent === null) stale.current.add(current.pane.id);
    ui.setCapturedPane(null, null);
  }, [cancelPress, clearTimer]);

  const open = useCallback(
    (pane: PaneInfo, via: PeekVia, anchor: HTMLElement) => {
      clearTimer();
      if (!onPeek) return;
      const ui = useUiStore.getState();
      if (ui.copyModeOpen) return;
      const next = { pane, via, anchor };
      if (peekRef.current?.pane.id === pane.id) {
        peekRef.current = next;
        setPeek(next);
        return;
      }
      stale.current.delete(pane.id);
      ui.setCapturedPane(pane.id, null);
      peekRef.current = next;
      setPeek(next);
      onPeek(pane);
    },
    [clearTimer, onPeek],
  );

  useEffect(
    () =>
      useUiStore.subscribe((state) => {
        const id = state.capturedPaneId;
        if (!id || state.capturedContent === null || state.copyModeOpen) return;
        if (!stale.current.has(id) || peekRef.current?.pane.id === id) return;
        stale.current.delete(id);
        state.setCapturedPane(null, null);
      }),
    [],
  );

  // Timers die with the grid, and an open peek gives back the capture slot.
  useEffect(() => () => close(), [close]);

  const scheduleClose = useCallback(() => {
    clearTimer();
    if (peekRef.current?.via === "hover") timer.current = window.setTimeout(close, PEEK_CLOSE_MS);
  }, [clearTimer, close]);

  /** Hover handlers for the cell box. Mouse only: touch has no hover. */
  const hover = (pane: PaneInfo) =>
    onPeek
      ? {
          onPointerEnter: (event: React.PointerEvent<HTMLElement>) => {
            if (event.pointerType !== "mouse" || event.buttons) return;
            const anchor = event.currentTarget;
            clearTimer();
            const current = peekRef.current;
            if (current) {
              // A peek is up: the next cell shows at once, like a row of tooltips.
              if (current.via === "hover" && current.pane.id !== pane.id) open(pane, "hover", anchor);
              return;
            }
            timer.current = window.setTimeout(() => open(pane, "hover", anchor), PEEK_DELAY_MS);
          },
          onPointerLeave: (event: React.PointerEvent<HTMLElement>) => {
            if (event.pointerType !== "mouse") return;
            if (peekRef.current) scheduleClose();
            else clearTimer();
          },
        }
      : {};

  /** Pointer down on the cell button. A press acts on the cell, so a mouse peek steps aside. */
  const pointerDown = (event: React.PointerEvent<HTMLElement>, pane: PaneInfo) => {
    lastPointer.current = event.pointerType;
    pressed.current = false;
    cancelPress();
    clearTimer();
    if (event.pointerType !== "touch") {
      if (peekRef.current) close();
      return;
    }
    if (!onPeek || !event.isPrimary) return;
    const anchor = event.currentTarget;
    press.current = {
      x: event.clientX,
      y: event.clientY,
      timer: window.setTimeout(() => {
        press.current = null;
        pressed.current = true;
        open(pane, "touch", anchor);
      }, PEEK_DELAY_MS),
    };
  };

  const pointerMove = (event: React.PointerEvent<HTMLElement>) => {
    const start = press.current;
    if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > PRESS_SLOP_PX) {
      cancelPress();
    }
  };

  /** True once for the click that ends a long press. */
  const consumeClick = () => {
    const was = pressed.current;
    pressed.current = false;
    return was;
  };

  /**
   * A touch long press fires `contextmenu` on Android. With peek on, that
   * press peeks and the menu stays shut. True when the event was taken.
   */
  const contextMenu = (event: React.MouseEvent<HTMLElement>, pane: PaneInfo) => {
    if (!onPeek || lastPointer.current !== "touch") return false;
    event.preventDefault();
    if (!peekRef.current) {
      cancelPress();
      pressed.current = true;
      open(pane, "touch", event.currentTarget);
    }
    return true;
  };

  /** P on a focused cell opens the peek and moves focus into it, P again closes it. */
  const toggleKey = (pane: PaneInfo, anchor: HTMLElement) => {
    if (peekRef.current?.pane.id === pane.id) close();
    else open(pane, "key", anchor);
  };

  return {
    peek,
    enabled: !!onPeek,
    open,
    close,
    hover,
    pointerDown,
    pointerMove,
    pointerUp: cancelPress,
    consumeClick,
    contextMenu,
    toggleKey,
    keepOpen: clearTimer,
    scheduleClose,
  };
}

/**
 * The last lines of a pane beside its cell.
 *
 * Opened by hover it takes no focus and closes when the pointer leaves both
 * the cell and the popover. Opened by key it moves focus to the text, where
 * arrow keys scroll it, and Escape, P or Tab hands focus back to the cell.
 * Focus moving anywhere else, a press outside or Escape close it in every
 * case.
 */
export function PanePeek({
  peek,
  onClose,
  onPointerEnter,
  onPointerLeave,
  returnFocus,
}: {
  peek: Peek | null;
  onClose: () => void;
  onPointerEnter: () => void;
  onPointerLeave: () => void;
  /** Focus the cell this peek belongs to. */
  returnFocus: (paneId: string) => void;
}) {
  const content = useUiStore((s) =>
    peek && s.capturedPaneId === peek.pane.id ? s.capturedContent : null,
  );
  const contentRef = useRef<HTMLDivElement>(null);
  const last = useRef(peek);
  if (peek) last.current = peek;
  // Beside the whole grid at the cell's height, so the popover never covers
  // the other cells of the window.
  const anchor = useMemo(() => {
    const cell = peek?.anchor;
    if (!cell) return { current: null };
    return {
      current: {
        getBoundingClientRect: () => {
          const own = cell.getBoundingClientRect();
          const grid = cell.closest("[role=group]")?.getBoundingClientRect() ?? own;
          return DOMRect.fromRect({
            x: grid.left,
            y: own.top,
            width: grid.width,
            height: own.height,
          });
        },
      },
    };
  }, [peek?.anchor]);
  const lines = content === null ? null : peekLines(content);
  const name = peek ? paneCellName(peek.pane) : "";

  return (
    <PopoverPrimitive.Root
      open={!!peek}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <PopoverPrimitive.Anchor virtualRef={anchor} />
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          ref={contentRef}
          side="right"
          align="start"
          sideOffset={6}
          collisionPadding={8}
          hideWhenDetached
          aria-label={`Peek at pane ${peek?.pane.index ?? ""}`}
          onOpenAutoFocus={(event) => {
            if (peek?.via !== "key") event.preventDefault();
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            const was = last.current;
            if (was?.via !== "key") return;
            // Back to the cell, unless focus already went somewhere else.
            const active = document.activeElement;
            if (!active || active === document.body || contentRef.current?.contains(active)) {
              returnFocus(was.pane.id);
            }
          }}
          // A touch focuses the pressed cell when the finger lifts, after a
          // long press opened the peek. That cell is not focus going away.
          onFocusOutside={(event) => {
            if (peek?.anchor.contains(event.target as Node)) event.preventDefault();
          }}
          onPointerEnter={onPointerEnter}
          onPointerLeave={(event) => {
            if (event.pointerType === "mouse") onPointerLeave();
          }}
          onKeyDown={(event) => {
            const p = (event.key === "p" || event.key === "P") && !event.altKey && !event.ctrlKey && !event.metaKey;
            // The popover sits at the end of the page, so Tab would leave
            // the tree for nowhere. It closes and hands focus back instead.
            if (p || event.key === "Tab") {
              event.preventDefault();
              onClose();
            }
          }}
          className="z-[var(--z-modal)] flex w-max min-w-64 max-w-[min(36rem,var(--radix-popover-content-available-width))] flex-col overflow-hidden rounded-md border bg-popover font-chrome text-popover-foreground shadow-[var(--shadow-float)] outline-none motion-safe:data-[state=open]:animate-in motion-safe:data-[state=open]:fade-in-0"
        >
          <div className="flex min-w-0 items-center gap-1.5 border-b px-2.5 py-1.5 text-xs leading-4 text-muted-foreground">
            {peek && <ProcessIcon command={peek.pane.command} className="h-3.5 w-3.5" />}
            <span className="min-w-0 truncate">{name}</span>
          </div>
          <div
            role="region"
            tabIndex={0}
            aria-label={`Last lines of pane ${peek?.pane.index ?? ""}`}
            aria-busy={lines === null}
            className="overflow-x-auto overscroll-x-contain focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
          >
            {lines === null ? (
              <p className="flex items-center gap-2 px-2.5 py-2 text-xs leading-4 text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 motion-safe:animate-spin" aria-hidden />
                Loading
              </p>
            ) : lines.length === 0 ? (
              <p className="px-2.5 py-2 text-xs leading-4 text-muted-foreground">No output yet</p>
            ) : (
              <pre className="w-max min-w-full px-2.5 py-2 font-mono text-xs leading-4 whitespace-pre text-foreground">
                {lines.join("\n")}
              </pre>
            )}
          </div>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
