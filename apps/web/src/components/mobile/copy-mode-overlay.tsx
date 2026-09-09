"use client";

import { useEffect, useCallback } from "react";
import { X, RefreshCw, Copy, ChevronDown } from "lucide-react";
import { Button } from "@repo/ui/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@repo/ui/components/ui/dropdown-menu";
import { MonacoEditor } from "@/components/files/monaco-editor";
import { useUiStore } from "@/stores/ui-store";
import { usePaneStore } from "@/stores/pane-store";
import { useAlertStore } from "@/stores/alert-store";
import { getRelayClient } from "@/hooks/use-websocket";
import { copyText, copyFailureReason } from "@/lib/clipboard";
import { isShell } from "@/lib/shell-commands";

function shortenPath(path: string): string {
  if (!path) return "";
  return path.replace(/^\/home\/[^/]+/, "~").replace(/^\/root/, "~");
}

function formatPaneName(command?: string, path?: string): string {
  if (!command || isShell(command)) {
    return path ? shortenPath(path) : command || "shell";
  }
  return path ? `${command} · ${shortenPath(path)}` : command;
}

export function CopyModeOverlay() {
  // Per field: this overlay stays mounted over a live pane, and an unselected
  // subscription re-renders the Monaco editor below on every unrelated store
  // write — including the font-size writes a pinch produces by the frame.
  const capturedPaneId = useUiStore((s) => s.capturedPaneId);
  const capturedContent = useUiStore((s) => s.capturedContent);
  const setCopyModeOpen = useUiStore((s) => s.setCopyModeOpen);
  const setCapturedPane = useUiStore((s) => s.setCapturedPane);
  const panes = usePaneStore((s) => s.panes);
  const activePaneId = usePaneStore((s) => s.activePaneId);
  const windows = usePaneStore((s) => s.windows);

  const currentPaneId = capturedPaneId ?? activePaneId;
  const currentPane = panes.find((p) => p.id === currentPaneId);

  // Request capture on mount for active pane
  useEffect(() => {
    const id = activePaneId;
    if (!id) return;
    getRelayClient()?.send({ type: "pane:capture", id });
  }, [activePaneId]);

  const handleClose = useCallback(() => {
    setCopyModeOpen(false);
  }, [setCopyModeOpen]);

  const handleRefresh = useCallback(() => {
    if (!currentPaneId) return;
    setCapturedPane(currentPaneId, null);
    getRelayClient()?.send({ type: "pane:capture", id: currentPaneId });
  }, [currentPaneId, setCapturedPane]);

  const handlePaneSwitch = useCallback(
    (paneId: string) => {
      setCapturedPane(paneId, null);
      getRelayClient()?.send({ type: "pane:capture", id: paneId });
    },
    [setCapturedPane],
  );

  const handleCopyAll = useCallback(async () => {
    if (!capturedContent) return;
    // Not `navigator.clipboard` directly: on the self-hosted LAN origin the
    // whole API is undefined, and this is *the* copy button on the *copy*
    // screen. `copyText` falls back to execCommand, which does work there.
    if (await copyText(capturedContent)) {
      useAlertStore.getState().push("success", "Copied to clipboard");
    } else {
      useAlertStore.getState().push("error", copyFailureReason());
    }
  }, [capturedContent]);

  // Group panes by window
  const panesByWindow = new Map<string, typeof panes>();
  for (const pane of panes) {
    const list = panesByWindow.get(pane.windowId) ?? [];
    list.push(pane);
    panesByWindow.set(pane.windowId, list);
  }

  return (
    // `fixed` escapes AppShell's frame, so the bars carry their own insets or
    // they run under the notch and the home indicator.
    <div className="fixed inset-0 z-[var(--z-panel)] flex flex-col bg-background pb-[env(safe-area-inset-bottom)] pt-[env(safe-area-inset-top)]">
      {/* Top bar — title + pane switcher */}
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <span className="text-sm font-medium">Copy Mode</span>
        <div className="flex-1" />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              className="h-8 gap-1 text-xs max-w-[180px]"
            >
              <span className="truncate">
                {currentPane
                  ? `${currentPane.index}: ${formatPaneName(currentPane.command, currentPane.path)}`
                  : "Select pane"}
              </span>
              <ChevronDown className="h-3 w-3 shrink-0" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {Array.from(panesByWindow.entries()).map(
              ([windowId, windowPanes], i) => {
                const win = windows.find((w) => w.id === windowId);
                return (
                  <div key={windowId}>
                    {i > 0 && <DropdownMenuSeparator />}
                    {windows.length > 1 && (
                      <DropdownMenuLabel className="text-xs">
                        {win?.name ?? windowId}
                      </DropdownMenuLabel>
                    )}
                    {windowPanes.map((pane) => (
                      <DropdownMenuItem
                        key={pane.id}
                        className="text-xs"
                        onClick={() => handlePaneSwitch(pane.id)}
                      >
                        {pane.index}: {formatPaneName(pane.command, pane.path)}
                      </DropdownMenuItem>
                    ))}
                  </div>
                );
              },
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-hidden">
        {capturedContent === null ? (
          <div className="flex h-full items-center justify-center text-muted-foreground">
            <RefreshCw className="h-5 w-5 animate-spin mr-2" />
            <span className="text-sm">Capturing pane content...</span>
          </div>
        ) : (
          <MonacoEditor
            content={capturedContent}
            language="plaintext"
            readOnly
            wordWrap="on"
            fontSize={13}
          />
        )}
      </div>

      {/* Bottom action bar — thumb-reachable actions */}
      <div className="flex items-center gap-2 border-t px-3 py-2">
        <Button
          variant="ghost"
          size="sm"
          className="h-11 gap-1 text-xs"
          onClick={handleClose}
        >
          <X className="h-4 w-4" />
          Close
        </Button>
        <div className="flex-1" />
        <Button
          variant="ghost"
          size="icon"
          className="h-11 w-11"
          aria-label="Recapture pane"
          onClick={handleRefresh}
        >
          <RefreshCw className="h-4 w-4" />
        </Button>
        <Button
          variant="secondary"
          size="sm"
          className="h-11 gap-1 text-xs"
          onClick={handleCopyAll}
          disabled={!capturedContent}
        >
          <Copy className="h-3.5 w-3.5" />
          Copy All
        </Button>
      </div>
    </div>
  );
}
