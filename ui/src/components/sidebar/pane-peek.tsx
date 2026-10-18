import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import type { PaneInfo } from "@/protocol";
import { paneCellName, gridAspect } from "@/lib/pane-grid-layout";
import { useUiStore } from "@/stores/ui-store";
import { TerminalScreen } from "@/components/terminal/terminal-screen";
import { previewKey, useTerminalPreviewStore, watchPreview } from "@/stores/terminal-preview-store";
import { useMachineStore } from "@/stores/machine-store";
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

/** Shared hover, long press and keyboard gestures. Output lives in preview store. */
export function usePanePeek(enabled: boolean) {
  const [peek, setPeek] = useState<Peek | null>(null);
  const peekRef = useRef(peek);
  peekRef.current = peek;
  const timer = useRef<number | null>(null);
  const press = useRef<{ x: number; y: number; timer: number } | null>(null);
  // A long press opened the peek. The click that follows the lift is not a select.
  const pressed = useRef(false);
  const lastPointer = useRef<string>("mouse");

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
  }, [cancelPress, clearTimer]);

  const open = useCallback(
    (pane: PaneInfo, via: PeekVia, anchor: HTMLElement) => {
      clearTimer();
      if (!enabled) return;
      const ui = useUiStore.getState();
      if (ui.copyModeOpen) return;
      const next = { pane, via, anchor };
      if (peekRef.current?.pane.id === pane.id) {
        peekRef.current = next;
        setPeek(next);
        return;
      }
      peekRef.current = next;
      setPeek(next);
    },
    [clearTimer, enabled],
  );

  // Timers and subscription owners die with the row or grid.
  useEffect(() => () => close(), [close]);
  useEffect(() => {
    if (!enabled) close();
  }, [enabled, close]);

  const scheduleClose = useCallback(() => {
    clearTimer();
    if (peekRef.current?.via === "hover") timer.current = window.setTimeout(close, PEEK_CLOSE_MS);
  }, [clearTimer, close]);

  /** Hover handlers for the cell box. Mouse only: touch has no hover. */
  const hover = (pane: PaneInfo) =>
    enabled
      ? {
          onPointerEnter: (event: React.PointerEvent<HTMLElement>) => {
            if (event.pointerType !== "mouse" || event.buttons) return;
            const anchor = event.currentTarget;
            clearTimer();
            const current = peekRef.current;
            if (current) {
              // A peek is up: the next cell shows at once, like a row of tooltips.
              if (current.via === "hover" && current.pane.id !== pane.id)
                open(pane, "hover", anchor);
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
    if (!enabled || !event.isPrimary) return;
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
    if (!enabled || lastPointer.current !== "touch") return false;
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
    enabled: !!enabled,
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
 * A live screen beside its cell.
 *
 * Opened by hover it takes no focus and closes when the pointer leaves both
 * the cell and the popover. Opened by key it moves focus to the text, where
 * Escape or P hands focus back to the cell. Tab moves out of the preview.
 * Focus moving anywhere else, a press outside or Escape close it in every
 * case.
 */
export function PanePeek({
  peek,
  scope,
  onClose,
  onPointerEnter,
  onPointerLeave,
  returnFocus,
}: {
  peek: Peek | null;
  scope: { machineId: string; session: string };
  onClose: () => void;
  onPointerEnter: () => void;
  onPointerLeave: () => void;
  /** Focus the cell this peek belongs to. */
  returnFocus: (paneId: string) => void;
}) {
  const owner = useId();
  const key = previewKey(scope.machineId, peek?.pane.id ?? "");
  const frame = useTerminalPreviewStore((s) => s.frames[key]);
  const supported = useMachineStore((s) =>
    s.machines
      .find((machine) => machine.id === scope.machineId)
      ?.features.includes("terminal:preview"),
  );
  const connected = useMachineStore((s) => s.inventory[scope.machineId]?.status === "connected");
  const paneId = peek?.pane.id;
  useEffect(() => {
    if (!paneId || !supported) return;
    return watchPreview(owner, scope.machineId, [{ session: scope.session, paneId }], true);
  }, [owner, scope.machineId, scope.session, paneId, supported]);
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
  const status = !supported
    ? "Update machine to enable previews"
    : !connected
      ? "Reconnecting…"
      : frame?.unavailable
        ? "Preview unavailable"
        : !frame
          ? "Loading preview…"
          : null;
  const aspect = gridAspect(frame ? { cols: frame.cols, rows: frame.rows } : peek?.pane.dimensions);
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
          style={{ width: `max(20rem, min(44rem, calc(65dvh * ${aspect})))` }}
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
            const p =
              (event.key === "p" || event.key === "P") &&
              !event.altKey &&
              !event.ctrlKey &&
              !event.metaKey;
            if (p) {
              event.preventDefault();
              onClose();
            }
          }}
          className="z-[var(--z-modal)] flex w-[44rem] max-w-[min(calc(100vw-1rem),var(--radix-popover-content-available-width))] flex-col overflow-hidden rounded-md border bg-popover font-chrome text-popover-foreground shadow-[var(--shadow-float)] outline-none motion-safe:data-[state=open]:animate-in motion-safe:data-[state=open]:fade-in-0"
        >
          <div className="flex min-w-0 items-center gap-1.5 border-b px-2.5 py-1.5 text-xs leading-4 text-muted-foreground">
            {peek && <ProcessIcon command={peek.pane.command} className="h-3.5 w-3.5" />}
            <span className="min-w-0 flex-1 truncate">{name}</span>
          </div>
          <div
            role="region"
            tabIndex={0}
            aria-label={`Terminal preview of pane ${peek?.pane.index ?? ""}`}
            aria-busy={supported && connected && !frame}
            className="relative w-full overflow-hidden bg-background focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
            style={{
              aspectRatio: aspect,
              maxHeight: "min(65dvh, calc(var(--radix-popover-content-available-height) - 3.5rem))",
            }}
          >
            {status ? (
              <p
                role="status"
                className="absolute inset-0 flex items-center justify-center p-3 text-center text-xs text-muted-foreground"
              >
                {status}
              </p>
            ) : (
              frame && (
                <>
                  <TerminalScreen frame={frame} />
                  <pre className="sr-only" aria-live="off">
                    {frame.content.replace(/\x1b\[[0-9;:]*m/g, "")}
                  </pre>
                </>
              )
            )}
          </div>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
