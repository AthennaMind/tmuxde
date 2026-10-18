import { useState, useRef, useCallback, useEffect } from "react";
import {
  Clock,
  PenLine,
  Trash2,
  ChevronRight,
  ChevronDown,
  MoreVertical,
  TerminalSquare,
  AppWindow,
  PanelTop,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from "@/components/ui/tooltip";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import type { SessionInfo, WindowInfo, PaneInfo } from "@/protocol";
import { getRelayClient } from "@/hooks/use-websocket";
import { useConnectionStore } from "@/stores/connection-store";
import { formatPaneName } from "@/lib/tmux-labels";

interface SessionCardProps {
  session: SessionInfo;
  isActive: boolean;
  onAttach: (name: string) => void;
  onKill: (name: string) => void;
}

function timeAgo(dateStr: string): string {
  const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function isRecentlyActive(dateStr: string): boolean {
  return Date.now() - new Date(dateStr).getTime() < 30_000;
}

export function SessionCard({ session, isActive, onAttach, onKill }: SessionCardProps) {
  const recentlyActive = isRecentlyActive(session.activity);
  const connectionStatus = useConnectionStore((s) => s.status);
  // Pending: user picked this session but the WS is still working through
  // (re)connect/auth — show a subtle visual so the click doesn't feel lost.
  const isPending = isActive && connectionStatus !== "connected";
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(session.name);
  const [showKillConfirm, setShowKillConfirm] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [detailWindows, setDetailWindows] = useState<WindowInfo[] | null>(null);
  const [detailPanes, setDetailPanes] = useState<PaneInfo[] | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const hasFetched = useRef(false);
  const unsubRef = useRef<(() => void) | null>(null);
  const detailTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearDetailSubscription = useCallback(() => {
    unsubRef.current?.();
    unsubRef.current = null;
    if (detailTimeoutRef.current) {
      clearTimeout(detailTimeoutRef.current);
      detailTimeoutRef.current = null;
    }
  }, []);

  const fetchDetails = useCallback(() => {
    if (hasFetched.current) return;
    const client = getRelayClient();
    if (!client) return;

    setDetailLoading(true);
    hasFetched.current = true;

    unsubRef.current = client.onMessage((msg) => {
      if (msg.type === "session:windows" && msg.name === session.name) {
        setDetailWindows(msg.windows);
        setDetailPanes(msg.panes);
        setDetailLoading(false);
        clearDetailSubscription();
      }
    });

    // Guard against a response that never arrives: clear the subscription so
    // it can't leak, and allow a retry on the next expand.
    detailTimeoutRef.current = setTimeout(() => {
      setDetailLoading(false);
      hasFetched.current = false;
      clearDetailSubscription();
    }, 10_000);

    client.send({ type: "session:windows", name: session.name });
  }, [session.name, clearDetailSubscription]);

  // Ensure any in-flight subscription/timeout is torn down on unmount.
  useEffect(() => clearDetailSubscription, [clearDetailSubscription]);

  const handleToggleExpand = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      const next = !expanded;
      setExpanded(next);
      if (next) fetchDetails();
    },
    [expanded, fetchDetails],
  );

  const handleRenameSubmit = useCallback(() => {
    const trimmed = renameValue.trim();
    if (trimmed && trimmed !== session.name) {
      getRelayClient()?.send({
        type: "session:rename",
        oldName: session.name,
        newName: trimmed,
      });
    }
    setIsRenaming(false);
  }, [renameValue, session.name]);

  const triggerKill = useCallback(() => {
    setShowKillConfirm(true);
  }, []);

  // Group panes by window
  const panesByWindow = detailPanes?.reduce<Record<string, PaneInfo[]>>((acc, pane) => {
    (acc[pane.windowId] ??= []).push(pane);
    return acc;
  }, {});

  return (
    <div className="relative overflow-hidden rounded-lg">
      <Card
        className={cn(
          "cursor-pointer transition-colors hover:bg-accent/50 relative",
          isActive && "bg-accent/40 ring-1 ring-primary/30",
          isPending && "animate-pulse-fast",
        )}
        onClick={() => onAttach(session.name)}
        aria-busy={isPending || undefined}
      >
        <CardContent className="px-2.5 py-2 space-y-1">
          {/* Row 1: chevron + status dot + name + menu */}
          <div className="flex items-center gap-1.5">
            <button
              className="shrink-0 rounded p-1 -m-0.5 text-muted-foreground hover:bg-accent active:bg-accent"
              onClick={handleToggleExpand}
              aria-label={expanded ? "Collapse" : "Expand"}
            >
              {expanded ? (
                <ChevronDown className="h-4 w-4" />
              ) : (
                <ChevronRight className="h-4 w-4" />
              )}
            </button>

            <TooltipProvider delayDuration={300}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span
                    className={cn(
                      "shrink-0 h-2 w-2 rounded-full",
                      session.attached
                        ? "bg-green-500"
                        : recentlyActive
                          ? "bg-yellow-500"
                          : "bg-muted-foreground/40",
                    )}
                  />
                </TooltipTrigger>
                <TooltipContent side="right" className="text-xs">
                  {session.attached ? "Attached" : recentlyActive ? "Recently active" : "Detached"}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>

            <div className="min-w-0 flex-1">
              {isRenaming ? (
                <Input
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleRenameSubmit();
                    if (e.key === "Escape") setIsRenaming(false);
                  }}
                  onBlur={handleRenameSubmit}
                  className="h-6 text-xs px-1"
                  autoFocus
                  onClick={(e) => e.stopPropagation()}
                />
              ) : (
                <span className="block truncate font-medium text-xs">{session.name}</span>
              )}
            </div>

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  // 24px glyph, 44px hit area — the card row is too tight for a
                  // button that large, so the target grows via a pseudo-element.
                  className="relative h-6 w-6 shrink-0 text-muted-foreground before:absolute before:-inset-2.5"
                  onClick={(e) => e.stopPropagation()}
                  aria-label="Session actions"
                >
                  <MoreVertical className="h-3.5 w-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  onClick={(e) => {
                    e.stopPropagation();
                    setRenameValue(session.name);
                    setIsRenaming(true);
                  }}
                >
                  <PenLine className="mr-2 h-3.5 w-3.5" />
                  Rename
                </DropdownMenuItem>
                <DropdownMenuItem
                  className="text-destructive"
                  onClick={(e) => {
                    e.stopPropagation();
                    triggerKill();
                  }}
                >
                  <Trash2 className="mr-2 h-3.5 w-3.5" />
                  Kill
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          {/* Row 2: window/pane counts + time */}
          <div className="flex items-center gap-2.5 pl-[26px] text-muted-foreground">
            <span
              className="flex items-center gap-0.5"
              title={`${session.windows} window${session.windows !== 1 ? "s" : ""}`}
            >
              <AppWindow className="h-3 w-3" />
              <span className="text-[10px]">{session.windows}</span>
            </span>
            {detailPanes && (
              <span
                className="flex items-center gap-0.5"
                title={`${detailPanes.length} pane${detailPanes.length !== 1 ? "s" : ""}`}
              >
                <PanelTop className="h-3 w-3" />
                <span className="text-[10px]">{detailPanes.length}</span>
              </span>
            )}
            <span className="flex items-center gap-0.5">
              <Clock className="h-2.5 w-2.5" />
              <span className="text-[10px]">{timeAgo(session.activity)}</span>
            </span>
          </div>
        </CardContent>

        {/* Expanded windows/panes tree */}
        {expanded && (
          <div className="border-t px-2.5 py-1.5" onClick={(e) => e.stopPropagation()}>
            {detailLoading ? (
              <div className="space-y-1">
                {Array.from({ length: 2 }).map((_, i) => (
                  <div key={i} className="flex items-center gap-2 pl-4">
                    <div className="h-3 w-3 animate-pulse rounded bg-muted" />
                    <div className="h-3 flex-1 animate-pulse rounded bg-muted" />
                  </div>
                ))}
              </div>
            ) : detailWindows && panesByWindow ? (
              <div className="space-y-0.5">
                {detailWindows.map((win) => (
                  <div key={win.id}>
                    <div className="flex items-center gap-1 pl-3 text-[11px]">
                      <TerminalSquare className="h-2.5 w-2.5 text-muted-foreground" />
                      <span className="font-medium truncate">
                        {win.index}: {win.name}
                      </span>
                      <span className="text-[10px] text-muted-foreground ml-auto shrink-0">
                        {win.paneCount}p
                      </span>
                    </div>
                    {panesByWindow[win.id]?.map((pane) => (
                      <div
                        key={pane.id}
                        className="flex items-center gap-1 pl-6 border-l border-border ml-[14px] text-[11px] text-muted-foreground py-px"
                      >
                        <span className="font-mono text-[10px]">{pane.index}</span>
                        <span className="truncate">{formatPaneName(pane.command, pane.path)}</span>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        )}
      </Card>
      <AlertDialog open={showKillConfirm} onOpenChange={setShowKillConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Kill session &quot;{session.name}&quot;?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently terminate the session and all its processes. This action cannot
              be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => onKill(session.name)}
            >
              Kill Session
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
