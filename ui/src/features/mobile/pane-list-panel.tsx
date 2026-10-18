import { useState } from "react";
import { LayoutGrid, Maximize2, Minimize2, Trash2 } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { PaneGrid, type PaneGridProps } from "@/features/panes/pane-grid";
import { ProcessIcon } from "@/features/panes/process-icon";
import { cn } from "@/shared/utils";
import { useStableMediaQuery } from "@/shared/use-media-query";
import { zoomPane } from "@/features/panes/pane-zoom";
import { MOBILE_MEDIA_QUERY } from "@/shared/mobile-query";
import { paneCellText } from "@/features/panes/pane-grid-layout";
import { windowPresentation } from "@/features/session/session-presentation";
import { usePaneStore } from "@/features/panes/pane-store";
import { useSettingsStore } from "@/features/settings/settings-store";
import { useUiStore } from "@/features/workspace/ui-store";
import { getRelayClient } from "@/features/connection/use-websocket";

/**
 * The window on screen as a pane grid, in a sheet.
 *
 * A tap on a cell selects that pane, and on a phone zooms it too. The menu
 * in the corner of each cell zooms or kills that pane without selecting it
 * first. The pane row under the grid names the pane the kill button acts
 * on, for the keyboard: the cell with keyboard focus, else the active pane.
 */
export function PaneListPanel() {
  const panes = usePaneStore((s) => s.panes);
  const windows = usePaneStore((s) => s.windows);
  const activePaneId = usePaneStore((s) => s.activePaneId);
  const zoomedPaneId = usePaneStore((s) => s.zoomedPaneId);
  const pendingKey = usePaneStore((s) => s.pendingKey);
  const showIndex = useSettingsStore((s) => s.showPaneIndexes);
  const paneListOpen = useUiStore((s) => s.paneListOpen);
  const setPaneListOpen = useUiStore((s) => s.setPaneListOpen);
  // The same question the rest of the app asks, asked the same way. The plain
  // `useMediaQuery` this used re-evaluates during a pinch, and this flag
  // decides whether selecting a pane also zooms it. A zoom gesture could
  // silently change what the next tap does. The bare width query it carried
  // also called a phone in landscape a desktop. See MOBILE_MEDIA_QUERY.
  const isMobile = useStableMediaQuery(MOBILE_MEDIA_QUERY);
  // A bottom sheet suits a thumb. On desktop it would span the whole window,
  // so the grid opens beside the terminal, like Settings.
  const side = isMobile ? "bottom" : "right";
  /** The pane a "kill" tap is waiting on, if any. */
  const [killing, setKilling] = useState<string | null>(null);
  /** Cell with keyboard focus. The kill button follows it. */
  const [focused, setFocused] = useState<string | null>(null);

  const onOpenChange = (open: boolean) => {
    if (!open) setFocused(null);
    setPaneListOpen(open);
  };

  if (panes.length === 0) {
    if (!paneListOpen) return null;
    return (
      <Sheet open={paneListOpen} onOpenChange={onOpenChange}>
        {/* px/pt only: the sheet's own bottom padding carries the safe-area inset. */}
        <SheetContent side={side} className={cn("px-4 pt-4", isMobile && "h-[30vh]")}>
          <SheetHeader className="pb-2">
            <SheetTitle className="text-sm">Panes</SheetTitle>
            <SheetDescription className="sr-only">Panes of the window on screen.</SheetDescription>
          </SheetHeader>
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
            <LayoutGrid className="h-10 w-10 mb-2 opacity-40" />
            <p className="text-sm">No panes available</p>
            <p className="text-xs mt-1">Attach to a session to see panes</p>
          </div>
        </SheetContent>
      </Sheet>
    );
  }

  // `panes` is the window tmux shows. Its own window id names the layout,
  // also while a window switch is half announced.
  const win = windows.find((w) => w.id === panes[0]?.windowId);
  const label = win ? windowPresentation(win.name, panes).label : undefined;
  const target =
    panes.find((p) => p.id === focused) ?? panes.find((p) => p.id === activePaneId) ?? panes[0]!;
  const targetText = paneCellText(target);

  const handleSelectPane = (id: string) => {
    const client = getRelayClient();
    if (!client) return;

    if (isMobile) {
      // Auto-zoom on mobile: if tapping the already active+zoomed pane, just close
      if (id === activePaneId && id === zoomedPaneId) {
        onOpenChange(false);
        return;
      }

      // `pane:select` on the relay uses `select-pane -Z`, which carries the
      // zoom across the selection. The old unzoom, select, rezoom triple
      // flickered. Every pane of a zoomed window used to report `zoomed`, so
      // it often rezoomed a pane the user had not chosen.
      client.send({ type: "pane:select", id });
      if (!zoomedPaneId) zoomPane({ id, zoomed: true });
    } else {
      client.send({ type: "pane:select", id });
    }

    onOpenChange(false);
  };

  const killingPane = panes.find((p) => p.id === killing);

  // Acts on the pane the menu belongs to. On touch the corner button always
  // shows, so a pane that is not active is one tap from its kill confirm.
  const paneMenu: PaneGridProps["menu"] = (pane) => {
    const zoomed = pane.id === zoomedPaneId;
    return [
      {
        label: zoomed ? "Unzoom" : "Zoom",
        icon: zoomed ? Minimize2 : Maximize2,
        onSelect: () => zoomPane({ id: pane.id, zoomed: !zoomed }),
      },
      {
        label: "Kill pane",
        icon: Trash2,
        shortcut: "Del",
        destructive: true,
        separated: true,
        onSelect: () => setKilling(pane.id),
      },
    ];
  };

  return (
    <>
      <Sheet open={paneListOpen} onOpenChange={onOpenChange}>
        <SheetContent
          side={side}
          className={cn("flex flex-col gap-3 px-4 pt-4", isMobile && "max-h-[85dvh]")}
        >
          {/* `pe-8` clears the sheet's own close button in the top corner. */}
          <SheetHeader className="space-y-0 pe-8 text-start sm:text-start">
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0 space-y-0.5">
                <SheetTitle className="text-sm">Panes</SheetTitle>
                <SheetDescription className="truncate text-xs">
                  {[
                    win ? `Window ${win.index} ${label}` : undefined,
                    `${panes.length} pane${panes.length === 1 ? "" : "s"}`,
                  ]
                    .filter(Boolean)
                    .join(", ")}
                </SheetDescription>
              </div>
              <Button
                variant="ghost"
                size="icon"
                className="h-11 w-11 shrink-0"
                aria-label={zoomedPaneId ? "Unzoom pane" : "Zoom pane"}
                title={zoomedPaneId ? "Unzoom" : "Zoom"}
                onClick={() => zoomPane()}
              >
                {zoomedPaneId ? (
                  <Minimize2 className="h-3.5 w-3.5" aria-hidden />
                ) : (
                  <Maximize2 className="h-3.5 w-3.5" aria-hidden />
                )}
              </Button>
            </div>
          </SheetHeader>

          {/* Full sheet width. The grid caps itself at 128px for the
              sidebar. A phone window is tall, so the cap is lifted here to
              keep stacked panes a thumb high. */}
          <div className="font-chrome">
            <PaneGrid
              size="card"
              maxHeight="min(45dvh, 24rem)"
              layout={win?.layout ?? ""}
              panes={panes}
              dimensions={win?.dimensions}
              focusId={activePaneId}
              zoomedId={zoomedPaneId}
              active
              pendingId={pendingKey}
              showIndex={showIndex}
              label={win ? `Panes of window ${win.index} ${label}` : "Panes"}
              onSelect={(pane) => handleSelectPane(pane.id)}
              onKill={(pane) => setKilling(pane.id)}
              menu={paneMenu}
              onFocusPane={(pane) => setFocused(pane.id)}
            />
          </div>

          {/* The pane the kill button acts on, by its index and what runs.
              Kept for the keyboard. Touch kills from the cell menu. */}
          <div className="flex min-h-11 items-center gap-2 font-chrome">
            <ProcessIcon command={target.command} active className="h-4 w-4" />
            <p className="min-w-0 flex-1 truncate text-[13px] leading-5">
              <span className="font-medium text-foreground">Pane {target.index}</span>{" "}
              <span className="text-muted-foreground">
                {[targetText.label, targetText.folder].filter(Boolean).join(" · ")}
              </span>
            </p>
            {/* Confirms, like the same action does on the tmux sheet. A
                killed pane cannot be brought back. */}
            <Button
              variant="ghost"
              className="h-11 shrink-0 px-3 text-muted-foreground hover:text-destructive"
              aria-label={`Kill pane ${target.index}`}
              onClick={() => setKilling(target.id)}
            >
              <Trash2 className="h-3.5 w-3.5" aria-hidden />
              Kill
            </Button>
          </div>
        </SheetContent>
      </Sheet>

      <AlertDialog
        open={killing !== null}
        onOpenChange={(open) => {
          if (!open) setKilling(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {killingPane ? `Kill pane ${killingPane.index}?` : "Kill this pane?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              The pane and every process running in it are terminated. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                if (killing) {
                  getRelayClient()?.send({ type: "pane:kill", id: killing });
                }
                setFocused(null);
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
