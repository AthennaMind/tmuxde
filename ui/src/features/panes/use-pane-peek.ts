import { useCallback, useEffect, useRef, useState } from "react";
import type { PaneInfo } from "@/protocol";
import { useUiStore } from "@/features/workspace/ui-store";

/** Hover this long before a peek opens. A long press waits as long. */
const PEEK_DELAY_MS = 500;
/** Time for the pointer to cross from the cell into the popover. */
const PEEK_CLOSE_MS = 150;
/** A touch that moves further than this scrolls, it does not press. */
const PRESS_SLOP_PX = 8;

/** How the peek opened. It decides focus and what closes it. */
type PeekVia = "hover" | "touch" | "key";

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
