"use client";

import { useEffect, useRef, useCallback } from "react";
import { ArrowUp, ArrowDown, ArrowLeft, ArrowRight, X } from "lucide-react";
import {
  Dialog,
  DialogContentRaw,
  DialogDescription,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
} from "@repo/ui/components/ui/dialog";
import { Button } from "@repo/ui/components/ui/button";
import { usePaneStore } from "@/stores/pane-store";
import { useUiStore } from "@/stores/ui-store";
import { getRelayClient } from "@/hooks/use-websocket";

const DIRECTION_LABELS: Record<"U" | "D" | "L" | "R", string> = {
  U: "Grow pane upwards",
  D: "Grow pane downwards",
  L: "Grow pane to the left",
  R: "Grow pane to the right",
};

/**
 * A D-pad layered over the terminal while resize mode is on.
 *
 * Built on Radix `Dialog` rather than the `fixed inset-0` pattern this
 * directory grew up with — the same call the command composer makes, for the
 * same reason: that pattern has no focus trap, no `role="dialog"`, no
 * `aria-modal` and no Escape handling, so what sits behind it is a live pty
 * that keyboard focus can wander back into while an opaque overlay hides it.
 * A surface whose whole job is to swallow input has to actually swallow it.
 *
 * `DialogContentRaw` rather than `DialogContent`, because the chrome here is
 * the full-bleed backdrop, not a centred card.
 */
export function PaneResizeControls() {
  const activePaneId = usePaneStore((s) => s.activePaneId);
  const resizeModeActive = useUiStore((s) => s.resizeModeActive);
  const setResizeModeActive = useUiStore((s) => s.setResizeModeActive);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const sendResize = useCallback(
    (direction: "U" | "D" | "L" | "R") => {
      if (!activePaneId) return;
      getRelayClient()?.send({
        type: "pane:resize",
        id: activePaneId,
        direction,
        amount: 5,
      });
    },
    [activePaneId],
  );

  const stopRepeat = useCallback(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }, []);

  const startRepeat = useCallback(
    (direction: "U" | "D" | "L" | "R") => {
      // Never two at once: a second pointer landing on another arrow used to
      // orphan the first interval, and orphaned means it repeats forever.
      stopRepeat();
      sendResize(direction);
      intervalRef.current = setInterval(() => sendResize(direction), 200);
    },
    [sendResize, stopRepeat],
  );

  // The repeat has to die with the component too. Closing resize mode unmounts
  // this without a pointer event of any kind, and the interval outlives it —
  // which is a pane that keeps resizing after the overlay is gone.
  useEffect(() => stopRepeat, [stopRepeat]);

  const directionButton = (
    direction: "U" | "D" | "L" | "R",
    Icon: typeof ArrowUp,
  ) => (
    <Button
      variant="outline"
      size="icon"
      className="h-12 w-12"
      aria-label={DIRECTION_LABELS[direction]}
      onPointerDown={() => startRepeat(direction)}
      onPointerUp={stopRepeat}
      onPointerLeave={stopRepeat}
      // The one the original was missing. A touch interrupted by a call, a
      // notification or the browser claiming the gesture fires `pointercancel`
      // and nothing else — so without this the pane resizes until the tab is
      // closed.
      onPointerCancel={stopRepeat}
    >
      <Icon className="h-5 w-5" />
    </Button>
  );

  return (
    <Dialog
      open={resizeModeActive}
      onOpenChange={(open) => {
        if (!open) {
          stopRepeat();
          setResizeModeActive(false);
        }
      }}
    >
      <DialogPortal>
        <DialogOverlay className="z-[var(--z-transient)] bg-background/80 backdrop-blur-sm" />
        <DialogContentRaw className="fixed inset-0 z-[var(--z-transient)] flex items-center justify-center pb-[env(safe-area-inset-bottom)] pt-[env(safe-area-inset-top)] focus:outline-none">
          <div className="flex flex-col items-center gap-2">
            <DialogTitle className="mb-2 text-sm font-medium text-muted-foreground">
              Resize Pane
            </DialogTitle>
            {/* Not decoration: Radix names the dialog from the title and
                describes it from this, and "what does holding one of these
                do" is the one thing the arrows cannot say themselves. */}
            <DialogDescription className="sr-only">
              Each press moves the pane boundary five cells. Press and hold to
              keep moving it. Press Escape to leave resize mode.
            </DialogDescription>
            <div className="grid grid-cols-3 gap-2">
              <div />
              {directionButton("U", ArrowUp)}
              <div />
              {directionButton("L", ArrowLeft)}
              <Button
                variant="destructive"
                size="icon"
                className="h-12 w-12"
                aria-label="Done resizing"
                onClick={() => setResizeModeActive(false)}
              >
                <X className="h-5 w-5" />
              </Button>
              {directionButton("R", ArrowRight)}
              <div />
              {directionButton("D", ArrowDown)}
              <div />
            </div>
          </div>
        </DialogContentRaw>
      </DialogPortal>
    </Dialog>
  );
}
