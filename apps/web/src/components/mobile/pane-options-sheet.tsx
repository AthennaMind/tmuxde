"use client";

import { useEffect, useState } from "react";
import {
  Columns2,
  Crosshair,
  Maximize2,
  Minimize2,
  Move,
  Rows2,
  ScrollText,
  Trash2,
} from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@repo/ui/components/ui/sheet";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@repo/ui/components/ui/alert-dialog";
import { Button } from "@repo/ui/components/ui/button";
import { usePaneStore } from "@/stores/pane-store";
import { useUiStore } from "@/stores/ui-store";
import { zoomPane } from "@/lib/pane-zoom";
import { getRelayClient } from "@/hooks/use-websocket";

/**
 * What a long press on a pane offers.
 *
 * ## Why the gesture needed a menu of its own
 *
 * Every pane action already existed — in the FAB's three-tab sheet, in the
 * pane list, in the resize D-pad. What none of them had was a *target*: they
 * all act on whatever pane tmux currently considers active, so doing anything
 * to another pane meant switching to it first and remembering to switch back.
 * A press names a pane, which is the one piece that was missing, and it is why
 * this sheet takes a pane id rather than reading `activePaneId` like its
 * neighbours do.
 *
 * ## Why some actions select first
 *
 * `pane:split`, `tmux:copy-mode` and the resize D-pad are all session-scoped
 * on the relay: they act on the current pane and take no id. Rather than widen
 * three protocol messages, the actions that need it send `pane:select` first —
 * which is what a user doing this by hand would do, and which leaves tmux in
 * the state the screen is about to describe.
 *
 * Kill asks. Nothing else here does: everything else is either reversible or
 * costs one tap to undo, and a confirmation on those is what teaches people to
 * dismiss the one that matters.
 */
export function PaneOptionsSheet() {
  const paneMenuId = useUiStore((s) => s.paneMenuId);
  const setPaneMenuId = useUiStore((s) => s.setPaneMenuId);
  const setResizeModeActive = useUiStore((s) => s.setResizeModeActive);
  const setCopyModeOpen = useUiStore((s) => s.setCopyModeOpen);
  const setCapturedPane = useUiStore((s) => s.setCapturedPane);
  const panes = usePaneStore((s) => s.panes);
  const zoomedPaneId = usePaneStore((s) => s.zoomedPaneId);
  const [confirmKill, setConfirmKill] = useState(false);

  const pane = panes.find((p) => p.id === paneMenuId) ?? null;
  const close = () => setPaneMenuId(null);

  // A pane that went away while its menu was up — killed from another client,
  // or its shell exited. Closing beats a sheet describing something that is no
  // longer there. In an effect, not in the render: the store write would
  // otherwise happen during another component's render pass.
  useEffect(() => {
    if (paneMenuId && !pane) setPaneMenuId(null);
  }, [paneMenuId, pane, setPaneMenuId]);

  const select = () => {
    if (!pane) return;
    getRelayClient()?.send({ type: "pane:select", id: pane.id });
    // Optimistic, for the same reason the zoom helper is: the resize D-pad and
    // the FAB read `activePaneId`, and waiting for the relay's announcement
    // would point them at the pane the user just navigated away from.
    usePaneStore.getState().setActivePane(pane.id);
  };

  const run = (action: () => void) => () => {
    action();
    close();
  };

  const isZoomed = !!pane && zoomedPaneId === pane.id;

  const actions = pane
    ? [
        {
          icon: isZoomed ? Minimize2 : Maximize2,
          label: isZoomed ? "Unzoom" : "Zoom this pane",
          run: () => zoomPane({ id: pane.id, zoomed: !isZoomed }),
        },
        {
          icon: Crosshair,
          label: "Focus this pane",
          hidden: pane.active,
          run: select,
        },
        {
          icon: Move,
          label: "Resize",
          run: () => {
            select();
            setResizeModeActive(true);
          },
        },
        {
          icon: Columns2,
          label: "Split right",
          run: () => {
            select();
            getRelayClient()?.send({ type: "pane:split", direction: "h" });
          },
        },
        {
          icon: Rows2,
          label: "Split down",
          run: () => {
            select();
            getRelayClient()?.send({ type: "pane:split", direction: "v" });
          },
        },
        {
          icon: ScrollText,
          label: "Copy text",
          run: () => {
            // Scoped to this pane, not the active one: the overlay reads
            // `capturedPaneId` first, so seeding it is what makes the text
            // that appears the text under the finger.
            setCapturedPane(pane.id, null);
            getRelayClient()?.send({ type: "pane:capture", id: pane.id });
            setCopyModeOpen(true);
          },
        },
      ].filter((a) => !a.hidden)
    : [];

  const title = pane
    ? `Pane ${pane.index + 1}${pane.command ? ` · ${pane.command}` : ""}`
    : "Pane";

  return (
    <>
      <Sheet
        open={pane !== null && !confirmKill}
        onOpenChange={(open) => {
          if (!open) close();
        }}
      >
        <SheetContent side="bottom" className="px-4 pb-6 pt-4">
          <SheetHeader className="pb-2 text-left">
            <SheetTitle className="text-sm">{title}</SheetTitle>
            <SheetDescription className="text-xs">
              {pane
                ? `${pane.dimensions.cols}×${pane.dimensions.rows}${
                    pane.active ? " · focused" : ""
                  }${isZoomed ? " · zoomed" : ""}`
                : ""}
            </SheetDescription>
          </SheetHeader>

          <div className="space-y-1">
            {actions.map(({ icon: Icon, label, run: action }) => (
              <Button
                key={label}
                variant="ghost"
                // h-12: every row here is a primary tap target, and this sheet
                // is reached by a gesture that says the user is aiming.
                className="h-12 w-full justify-start gap-3 text-sm"
                onClick={run(action)}
              >
                <Icon className="h-4 w-4" />
                {label}
              </Button>
            ))}
            <Button
              variant="ghost"
              className="h-12 w-full justify-start gap-3 text-sm text-destructive hover:text-destructive"
              onClick={() => setConfirmKill(true)}
            >
              <Trash2 className="h-4 w-4" />
              Kill pane
            </Button>
          </div>
        </SheetContent>
      </Sheet>

      <AlertDialog
        open={confirmKill}
        onOpenChange={(open) => {
          if (!open) setConfirmKill(false);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Kill {title.toLowerCase()}?</AlertDialogTitle>
            <AlertDialogDescription>
              Whatever is running in it is killed with it. This cannot be
              undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (pane) {
                  getRelayClient()?.send({ type: "pane:kill", id: pane.id });
                }
                setConfirmKill(false);
                close();
              }}
            >
              Kill pane
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
