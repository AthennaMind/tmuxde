"use client";

import { useState } from "react";
import { Maximize2, X, LayoutGrid } from "lucide-react";
import {
  Sheet,
  SheetContent,
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
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  TooltipProvider,
} from "@repo/ui/components/ui/tooltip";
import { cn } from "@repo/ui/lib/utils";
import { useStableMediaQuery } from "@repo/ui/hooks/use-media-query";
import { useMiniScrollbar } from "@repo/ui/components/ui/mini-scrollbar";
import { MOBILE_MEDIA_QUERY } from "@/lib/mobile-query";
import { usePaneStore } from "@/stores/pane-store";
import { useUiStore } from "@/stores/ui-store";
import { getRelayClient } from "@/hooks/use-websocket";

const SHELL_COMMANDS = new Set([
  "bash",
  "zsh",
  "fish",
  "sh",
  "dash",
  "ksh",
  "tcsh",
  "csh",
]);

function shortenPath(path: string): string {
  if (!path) return "";
  // Replace home dir with ~
  const shortened = path.replace(/^\/home\/[^/]+/, "~").replace(/^\/root/, "~");
  return shortened;
}

function formatPaneName(command?: string, path?: string): string {
  if (!command || SHELL_COMMANDS.has(command)) {
    return path ? shortenPath(path) : command || "shell";
  }
  return path ? `${command} · ${shortenPath(path)}` : command;
}

export function PaneListPanel() {
  const panes = usePaneStore((s) => s.panes);
  const activePaneId = usePaneStore((s) => s.activePaneId);
  const zoomedPaneId = usePaneStore((s) => s.zoomedPaneId);
  const paneListOpen = useUiStore((s) => s.paneListOpen);
  const setPaneListOpen = useUiStore((s) => s.setPaneListOpen);
  // The same question the rest of the app asks, asked the same way. The plain
  // `useMediaQuery` this used re-evaluates during a pinch, and this flag
  // decides whether selecting a pane also zooms it — so a zoom gesture could
  // silently change what the next tap does. The bare width query it carried
  // also called a phone in landscape a desktop; see MOBILE_MEDIA_QUERY.
  const isMobile = useStableMediaQuery(MOBILE_MEDIA_QUERY);
  /** The pane a "kill" tap is waiting on, if any. */
  const [killing, setKilling] = useState<string | null>(null);
  // A raw `overflow-y-auto`, so no scrollbar of any kind was drawn on touch —
  // a list of panes that plainly ran off the bottom with nothing to say so.
  const { ref: paneListRef, scrollbar: paneScrollbar } = useMiniScrollbar();

  if (panes.length === 0) {
    if (!paneListOpen) return null;
    return (
      <Sheet open={paneListOpen} onOpenChange={setPaneListOpen}>
        {/* px/pt only: the sheet's own bottom padding carries the safe-area inset. */}
        <SheetContent side="bottom" className="h-[30vh] px-4 pt-4">
          <SheetHeader className="pb-2">
            <SheetTitle className="text-sm">Panes</SheetTitle>
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

  const handleSelectPane = (id: string) => {
    const client = getRelayClient();
    if (!client) return;

    if (isMobile) {
      // Auto-zoom on mobile: if tapping the already active+zoomed pane, just close
      if (id === activePaneId && id === zoomedPaneId) {
        setPaneListOpen(false);
        return;
      }

      // `pane:select` on the relay uses `select-pane -Z`, which carries the
      // zoom across the selection. The old unzoom/select/rezoom triple
      // flickered, and — because every pane of a zoomed window used to report
      // `zoomed` — regularly rezoomed a pane the user had not chosen.
      client.send({ type: "pane:select", id });
      if (!zoomedPaneId) client.send({ type: "pane:zoom" });
    } else {
      client.send({ type: "pane:select", id });
    }

    setPaneListOpen(false);
  };

  const handleZoomPane = () => {
    getRelayClient()?.send({ type: "pane:zoom" });
  };

  const killingPane = panes.find((p) => p.id === killing);

  return (
    <>
      <Sheet open={paneListOpen} onOpenChange={setPaneListOpen}>
        <SheetContent
          side="bottom"
          className="flex h-[40vh] flex-col px-4 pt-4"
        >
          <SheetHeader className="pb-2">
            <div className="flex items-center justify-between">
              <SheetTitle className="text-sm">
                Panes ({panes.length})
              </SheetTitle>
              <TooltipProvider delayDuration={300}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-11 w-11"
                      aria-label={zoomedPaneId ? "Unzoom pane" : "Zoom pane"}
                      onClick={handleZoomPane}
                    >
                      <Maximize2 className="h-3.5 w-3.5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    {zoomedPaneId ? "Unzoom" : "Zoom"}
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </div>
          </SheetHeader>

          {/* Pane list */}
          <div className="relative mt-1 flex min-h-0 flex-1 flex-col">
            {paneScrollbar}
            <div
              ref={paneListRef}
              className="min-h-0 flex-1 overflow-y-auto space-y-1"
            >
              {panes.map((pane) => (
                <div
                  key={pane.id}
                  className={cn(
                    "flex items-center justify-between rounded-md px-3 py-2 text-sm",
                    pane.id === activePaneId
                      ? "bg-accent"
                      : "hover:bg-accent/50",
                  )}
                >
                  <button
                    className="flex min-h-11 flex-1 items-center gap-2 rounded-md text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    onClick={() => handleSelectPane(pane.id)}
                  >
                    <span className="font-mono text-xs text-muted-foreground">
                      {pane.index}
                    </span>
                    <span className="truncate">
                      {formatPaneName(pane.command, pane.path)}
                    </span>
                    {pane.dimensions && (
                      <span className="text-[10px] text-muted-foreground">
                        {pane.dimensions.cols}x{pane.dimensions.rows}
                      </span>
                    )}
                  </button>
                  {/* Confirms, like the same action does on the tmux sheet. It
                  sits 44px from the row's own tap-to-select target, so the
                  slip that costs you a running process is one thumb-width
                  wide — and a killed pane cannot be brought back. */}
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-11 w-11 shrink-0 text-muted-foreground hover:text-destructive"
                    aria-label={`Kill pane ${pane.index}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      setKilling(pane.id);
                    }}
                  >
                    <X className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ))}
            </div>
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
              {killingPane
                ? `Kill pane ${killingPane.index}?`
                : "Kill this pane?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              The pane and every process running in it are terminated. This
              cannot be undone.
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
              }}
            >
              Kill Pane
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
