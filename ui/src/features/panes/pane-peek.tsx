import { useEffect, useId, useMemo, useRef } from "react";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import { paneCellName, gridAspect } from "./pane-grid-layout";
import { TerminalScreen } from "@/features/terminal/terminal-screen";
import { previewKey, useTerminalPreviewStore, watchPreview } from "./terminal-preview-store";
import { useMachineStore } from "@/features/connection/machine-store";
import { ProcessIcon } from "./process-icon";
import type { Peek } from "./use-pane-peek";

/** Terminal color and style escapes, cut from the screen reader copy. */
// oxlint-disable-next-line no-control-regex -- matches the ESC byte of terminal escapes on purpose.
const SGR_ESCAPES = /\x1b\[[0-9;:]*m/g;

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
                    {frame.content.replace(SGR_ESCAPES, "")}
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
