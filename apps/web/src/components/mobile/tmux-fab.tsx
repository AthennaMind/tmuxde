"use client";

import { useState, useRef, useCallback } from "react";
import {
  Columns2,
  Rows2,
  Plus,
  Maximize2,
  Move,
  TerminalSquare,
  ArrowUpDown,
  PenLine,
  LayoutTemplate,
  RotateCw,
  ScrollText,
  Radio,
  LogOut,
  Trash2,
} from "lucide-react";
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
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@repo/ui/components/ui/dialog";
import { Button } from "@repo/ui/components/ui/button";
import { Input } from "@repo/ui/components/ui/input";
import { cn } from "@repo/ui/lib/utils";
import { useSessionStore } from "@/stores/session-store";
import { usePaneStore } from "@/stores/pane-store";
import { useUiStore } from "@/stores/ui-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useConnectionStore } from "@/stores/connection-store";
import { noteEnteredCopyMode } from "@/lib/copy-mode-belief";
import { getRelayClient } from "@/hooks/use-websocket";

type FabTab = "panes" | "windows" | "advanced";

/** A destructive action parked until the user confirms it. */
interface PendingConfirm {
  title: string;
  description: string;
  confirmLabel: string;
  run: () => void;
}

export function TmuxFab() {
  // Per field. The FAB is mounted for the whole life of an attached session,
  // so an unselected subscription re-renders it — and the sheet's whole action
  // grid — on every unrelated store write.
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const zoomedPaneId = usePaneStore((s) => s.zoomedPaneId);
  const fabOpen = useUiStore((s) => s.fabOpen);
  const setFabOpen = useUiStore((s) => s.setFabOpen);
  const setResizeModeActive = useUiStore((s) => s.setResizeModeActive);
  const connected = useConnectionStore((s) => s.status === "connected");
  const [activeTab, setActiveTab] = useState<FabTab>("panes");
  const [longPressOpen, setLongPressOpen] = useState(false);
  const [pendingConfirm, setPendingConfirm] = useState<PendingConfirm | null>(
    null,
  );
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleFabTouchStart = useCallback(() => {
    longPressTimer.current = setTimeout(() => {
      setLongPressOpen(true);
    }, 500);
  }, []);

  const handleFabTouchEnd = useCallback(() => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  }, []);

  const handleFabClick = useCallback(() => {
    if (!longPressOpen) {
      setFabOpen(!fabOpen);
    }
    setLongPressOpen(false);
  }, [longPressOpen, fabOpen, setFabOpen]);

  // Show whenever a session is attached (any mobile tab)
  if (!activeSessionId) return null;

  const handleSplit = (direction: "h" | "v") => {
    getRelayClient()?.send({ type: "pane:split", direction });
    // Auto-zoom into the new pane after split
    if (useSettingsStore.getState().autoZoom) {
      usePaneStore.getState().setPendingAutoZoom(true);
    }
    setFabOpen(false);
  };

  const handleRenameSubmit = () => {
    const name = renameValue.trim();
    const { activeWindowId } = usePaneStore.getState();
    if (name && activeWindowId) {
      getRelayClient()?.send({
        type: "window:rename",
        id: activeWindowId,
        name,
      });
    }
    setRenameOpen(false);
  };

  const paneActions = [
    {
      icon: Columns2,
      label: "Split H",
      action: () => handleSplit("h"),
    },
    {
      icon: Rows2,
      label: "Split V",
      action: () => handleSplit("v"),
    },
    {
      icon: Maximize2,
      label: zoomedPaneId ? "Unzoom" : "Zoom",
      action: () => {
        getRelayClient()?.send({ type: "pane:zoom" });
        setFabOpen(false);
      },
    },
    {
      icon: Move,
      label: "Resize",
      action: () => {
        setFabOpen(false);
        setResizeModeActive(true);
      },
    },
    {
      icon: ArrowUpDown,
      label: "Swap Pane",
      action: () => {
        const { activePaneId } = usePaneStore.getState();
        if (activePaneId) {
          getRelayClient()?.send({
            type: "pane:swap",
            id: activePaneId,
            direction: "D",
          });
        }
        setFabOpen(false);
      },
    },
    {
      icon: Trash2,
      label: "Kill Pane",
      variant: "destructive" as const,
      action: () => {
        const { activePaneId, panes } = usePaneStore.getState();
        setFabOpen(false);
        if (!activePaneId || panes.length < 2) return;
        setPendingConfirm({
          title: "Kill this pane?",
          description:
            "The pane and every process running in it are terminated. This cannot be undone.",
          confirmLabel: "Kill Pane",
          run: () =>
            getRelayClient()?.send({ type: "pane:kill", id: activePaneId }),
        });
      },
    },
  ];

  const windowActions = [
    {
      icon: Plus,
      label: "New Window",
      action: () => {
        getRelayClient()?.send({ type: "window:create" });
        setFabOpen(false);
      },
    },
    {
      icon: Trash2,
      label: "Kill Window",
      variant: "destructive" as const,
      action: () => {
        const { activeWindowId, windows } = usePaneStore.getState();
        setFabOpen(false);
        if (!activeWindowId) return;
        const name = windows.find((w) => w.id === activeWindowId)?.name;
        setPendingConfirm({
          title: name ? `Kill window "${name}"?` : "Kill this window?",
          description:
            "The window, all of its panes and every process in them are terminated. This cannot be undone.",
          confirmLabel: "Kill Window",
          run: () =>
            getRelayClient()?.send({ type: "window:kill", id: activeWindowId }),
        });
      },
    },
    {
      icon: PenLine,
      label: "Rename Win",
      action: () => {
        const { activeWindowId, windows } = usePaneStore.getState();
        setFabOpen(false);
        if (!activeWindowId) return;
        setRenameValue(
          windows.find((w) => w.id === activeWindowId)?.name ?? "",
        );
        setRenameOpen(true);
      },
    },
    {
      icon: LayoutTemplate,
      label: "Layout",
      action: () => {
        getRelayClient()?.send({ type: "window:layout", preset: "tiled" });
        setFabOpen(false);
      },
    },
    {
      icon: RotateCw,
      label: "Rotate",
      action: () => {
        getRelayClient()?.send({ type: "layout:rotate" });
        setFabOpen(false);
      },
    },
  ];

  const advancedActions = [
    {
      icon: ScrollText,
      label: "Copy Mode",
      action: () => {
        getRelayClient()?.send({ type: "tmux:copy-mode" });
        // Recorded so the next tap on the terminal knows to leave copy mode.
        // Without this the pane really is in copy mode while the client thinks
        // it isn't, and every keystroke afterwards is eaten as a copy-mode
        // command with no visible reason.
        noteEnteredCopyMode(useSessionStore.getState().activeSessionId);
        setFabOpen(false);
      },
    },
    {
      icon: Radio,
      label: "Send Prefix",
      action: () => {
        getRelayClient()?.send({ type: "tmux:prefix" });
        setFabOpen(false);
      },
    },
    {
      icon: LogOut,
      label: "Detach",
      action: () => {
        getRelayClient()?.send({ type: "session:detach" });
        setFabOpen(false);
      },
    },
  ];

  const tabs: { id: FabTab; label: string }[] = [
    { id: "panes", label: "Panes" },
    { id: "windows", label: "Windows" },
    { id: "advanced", label: "Advanced" },
  ];

  const currentActions =
    activeTab === "panes"
      ? paneActions
      : activeTab === "windows"
        ? windowActions
        : advancedActions;

  return (
    <>
      {/* FAB with long-press quick split. Positioned inside the terminal pane
          rather than the viewport so it can never reach — or swallow taps meant
          for — the footer chrome below it. */}
      {/* `right-5`, not `right-3`: the scroll rail owns the right 16px of the
          pane, and a FAB sitting on top of it takes the bottom of the track —
          the end of the history — out of reach. */}
      <div className="absolute bottom-3 right-5 z-[var(--z-fab)]">
        {longPressOpen && (
          <div className="absolute bottom-14 right-0 flex gap-1 rounded-lg border bg-background p-1 shadow-lg">
            <Button
              variant="outline"
              size="sm"
              className="gap-1 text-xs"
              disabled={!connected}
              onClick={() => {
                handleSplit("h");
                setLongPressOpen(false);
              }}
            >
              <Columns2 className="h-3.5 w-3.5" />
              Split H
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="gap-1 text-xs"
              disabled={!connected}
              onClick={() => {
                handleSplit("v");
                setLongPressOpen(false);
              }}
            >
              <Rows2 className="h-3.5 w-3.5" />
              Split V
            </Button>
          </div>
        )}
        <button
          className={cn(
            "flex h-11 w-11 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg transition-transform active:scale-95",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
            "disabled:opacity-50",
            fabOpen && "rotate-45",
          )}
          onClick={handleFabClick}
          aria-label="Tmux actions"
          disabled={!connected}
          onTouchStart={handleFabTouchStart}
          onTouchEnd={handleFabTouchEnd}
          onTouchCancel={handleFabTouchEnd}
        >
          <TerminalSquare className="h-5 w-5" />
        </button>
      </div>

      {/* Action sheet with tabs */}
      <Sheet open={fabOpen} onOpenChange={setFabOpen}>
        <SheetContent side="bottom">
          <SheetHeader className="pb-2">
            <SheetTitle className="text-sm">Tmux Actions</SheetTitle>
          </SheetHeader>

          {/* Tab bar */}
          <div className="mb-3 flex gap-1">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                className={cn(
                  "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                  "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                  activeTab === tab.id
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:bg-accent",
                )}
                onClick={() => setActiveTab(tab.id)}
              >
                {tab.label}
              </button>
            ))}
          </div>

          <div className="grid grid-cols-2 gap-2">
            {currentActions.map((item) => (
              <Button
                key={item.label}
                variant={
                  "variant" in item
                    ? (item.variant as "destructive")
                    : "outline"
                }
                className="flex h-auto items-center gap-2 px-3 py-2.5 text-xs justify-start"
                disabled={!connected}
                onClick={item.action}
              >
                <item.icon className="h-4 w-4" />
                {item.label}
              </Button>
            ))}
          </div>
        </SheetContent>
      </Sheet>

      {/* Kill pane / kill window sit next to harmless actions, so they confirm
          first — same contract as killing a session from the session list. */}
      <AlertDialog
        open={pendingConfirm !== null}
        onOpenChange={(open) => {
          if (!open) setPendingConfirm(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{pendingConfirm?.title}</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingConfirm?.description}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => pendingConfirm?.run()}
            >
              {pendingConfirm?.confirmLabel}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-base">Rename window</DialogTitle>
          </DialogHeader>
          <Input
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleRenameSubmit();
            }}
            placeholder="Window name"
            aria-label="Window name"
            autoFocus
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenameOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={handleRenameSubmit}
              disabled={!connected || !renameValue.trim()}
            >
              Rename
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
