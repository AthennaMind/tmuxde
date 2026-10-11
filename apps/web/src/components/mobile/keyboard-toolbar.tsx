"use client";

import { useState, useCallback, useEffect } from "react";
import {
  Keyboard,
  Search,
  Zap,
  Columns2,
  Rows2,
  Clipboard,
  ClipboardCopy,
  ClipboardPaste,
  ZoomIn,
  ZoomOut,
  MoreHorizontal,
  HelpCircle,
} from "lucide-react";
import { cn } from "@repo/ui/lib/utils";
import { triggerHaptic } from "@repo/ui/components/haptic-button";
import { useSettingsStore } from "@/stores/settings-store";
import { useCommandStore } from "@/stores/command-store";
import { usePaneStore } from "@/stores/pane-store";
import { useTerminalStore } from "@/stores/terminal-store";
import { useUiStore } from "@/stores/ui-store";
import { useAlertStore } from "@/stores/alert-store";
import { useConnectionStore } from "@/stores/connection-store";
import { getRelayClient } from "@/hooks/use-websocket";
import { useBelievedInCopyMode } from "@/hooks/use-copy-mode";
import { noteLeftCopyMode } from "@/lib/copy-mode-belief";
import { useSessionStore } from "@/stores/session-store";
import { sendKeySequence } from "@/lib/send-key";
import {
  consumeTerminalInput,
  useTerminalInput,
} from "@/lib/terminal-input.js";
import { NavigationToolbar } from "./navigation-toolbar";
import { RecentPhotos } from "@/components/terminal/recent-photos";
import { KeySheet } from "./key-sheet";
import { PhotoUpload } from "@/components/terminal/photo-upload";
import { GestureHelpSheet } from "./gesture-help-sheet";

interface KeyboardToolbarProps {
  className?: string;
  /** #6: Callback to trigger terminal search */
  onSearchOpen?: () => void;
  onCopy?: () => void;
  onFocusTerminal: () => void;
  onBlurTerminal: () => void;
}

export function KeyboardToolbar({
  className,
  onSearchOpen,
  onCopy,
  onFocusTerminal,
  onBlurTerminal,
}: KeyboardToolbarProps) {
  const toolbarKeys = useSettingsStore((s) => s.toolbarKeys);
  const hapticEnabled = useSettingsStore((s) => s.hapticEnabled);
  const stickyCtrl = useTerminalInput((s) => s.ctrl);
  const stickyAlt = useTerminalInput((s) => s.alt);
  const [navigation, setNavigation] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [typing, setTyping] = useState(false);
  const [keySheetOpen, setKeySheetOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  // Keys that travel to the relay are dead while the socket is down; the purely
  // local ones (search, palette, font size) stay live.
  const connected = useConnectionStore((s) => s.status === "connected");
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const inCopyMode = useBelievedInCopyMode(activeSessionId);
  const openComposer = useUiStore((s) => s.openComposer);

  useEffect(() => {
    const sync = () =>
      setTyping(
        document.activeElement?.classList.contains("xterm-helper-textarea") ??
          false,
      );
    document.addEventListener("focusin", sync);
    document.addEventListener("focusout", sync);
    return () => {
      document.removeEventListener("focusin", sync);
      document.removeEventListener("focusout", sync);
    };
  }, []);

  useEffect(() => {
    useTerminalInput.getState().reset();
    return () => useTerminalInput.getState().reset();
  }, [connected, activeSessionId]);

  const sendKey = useCallback(
    (key: string, focus = true) => {
      if (sendKeySequence(consumeTerminalInput(key)) && focus)
        onFocusTerminal();
    },
    [onFocusTerminal],
  );

  const handleKeyPress = useCallback(
    (id: string, key: string) => {
      if (id === "ctrl") {
        onFocusTerminal();
        useTerminalInput.getState().toggle("ctrl");
        if (hapticEnabled) triggerHaptic(20);
        return;
      }
      if (id === "alt") {
        onFocusTerminal();
        useTerminalInput.getState().toggle("alt");
        if (hapticEnabled) triggerHaptic(20);
        return;
      }
      // Arrow taps preserve keyboard state while navigating terminal apps.
      sendKey(key, !["left", "down", "up", "right"].includes(id));
    },
    [sendKey, hapticEnabled, onFocusTerminal],
  );

  /* A long press on a key used to fire its own 30ms buzz after 500ms and then
     do nothing at all. A haptic distinct from the tap one is a promise that
     something is about to happen; there was never a variants popup behind it,
     so the buzz was the whole feature. Removed rather than left to keep
     promising. */

  /** Signals bypass the sticky-modifier path — they are already control codes. */
  const sendSignal = useCallback(
    (data: string) => {
      useTerminalInput.getState().reset();
      if (sendKeySequence(data)) onFocusTerminal();
    },
    [onFocusTerminal],
  );

  const leaveCopyMode = useCallback(() => {
    useTerminalInput.getState().reset();
    noteLeftCopyMode(activeSessionId);
    getRelayClient()?.send({ type: "tmux:exit-copy-mode" });
    if (hapticEnabled) triggerHaptic();
  }, [activeSessionId, hapticEnabled]);

  const iconBtnClass =
    "flex h-11 w-11 shrink-0 items-center justify-center rounded-md border border-border bg-background text-foreground transition-colors active:bg-accent/80 active:scale-95 disabled:opacity-40 disabled:active:scale-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

  const coreIds = ["esc", "tab", "ctrl", "alt", "left", "down", "up", "right"];
  const visibleKeys = toolbarKeys.filter(
    (k) => k.visible && !coreIds.includes(k.id),
  );
  const keyClass =
    "flex h-11 min-w-0 items-center justify-center rounded-md border border-border bg-background px-1 text-xs font-medium text-foreground active:bg-accent disabled:opacity-40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";
  const coreKey = (id: string) => {
    const key = toolbarKeys.find((entry) => entry.id === id);
    if (!key) return null;
    const pressed =
      id === "ctrl" ? stickyCtrl : id === "alt" ? stickyAlt : undefined;
    const names: Record<string, string> = {
      left: "Arrow left",
      down: "Arrow down",
      up: "Arrow up",
      right: "Arrow right",
    };
    return (
      <button
        key={id}
        data-terminal-key
        data-extra-control={!["esc", "tab", "ctrl"].includes(id) || undefined}
        className={cn(
          keyClass,
          id === "ctrl" && "min-w-11",
          pressed && "border-primary bg-primary/20 text-primary",
        )}
        disabled={!connected || !activeSessionId}
        aria-label={names[id] ?? key.label}
        aria-pressed={pressed}
        onClick={() => handleKeyPress(id, key.key)}
      >
        {key.label}
      </button>
    );
  };

  return (
    <div
      className={cn("tmuxde-keyboard", className)}
      data-expanded={moreOpen}
      onPointerDown={(event) => {
        // Keep native keyboard open when tapping terminal keys.
        if ((event.target as HTMLElement).closest("button[data-terminal-key]"))
          event.preventDefault();
      }}
    >
      {navigation ? (
        <NavigationToolbar
          moreOpen={moreOpen}
          onMore={() => setMoreOpen(!moreOpen)}
          onKeyboard={() => {
            setNavigation(false);
            setMoreOpen(false);
            onFocusTerminal();
          }}
        />
      ) : (
        <div
          role="group"
          aria-label="Terminal keyboard"
          className="grid grid-cols-6 gap-1 p-1"
        >
          <button
            data-terminal-key
            className={cn(keyClass, typing && "border-primary text-primary")}
            aria-label={typing ? "Hide keyboard" : "Show keyboard"}
            disabled={!connected || !activeSessionId}
            onClick={() => {
              if (typing) {
                useTerminalInput.getState().reset();
                onBlurTerminal();
              } else onFocusTerminal();
            }}
          >
            <Keyboard className="h-4 w-4" />
          </button>
          <button
            data-extra-control
            className={keyClass}
            aria-label="Write a command"
            onClick={(event) => {
              event.currentTarget.focus({ preventScroll: true });
              useTerminalInput.getState().reset();
              openComposer();
            }}
          >
            Draft
          </button>
          {coreKey("esc")}
          {coreKey("tab")}
          <PhotoUpload compact />
          <button
            data-terminal-key
            className={keyClass}
            disabled={!connected || !activeSessionId}
            onClick={() => sendKey("\r")}
          >
            Enter
          </button>
          <button
            data-terminal-key
            className={keyClass}
            aria-label="More terminal controls"
            aria-expanded={moreOpen}
            onClick={() => setMoreOpen(!moreOpen)}
          >
            More
          </button>
          {["alt", "left", "down", "up", "right"].map(coreKey)}
        </div>
      )}
      {inCopyMode && (
        <button
          className={cn(keyClass, "mx-1 mb-1 w-[calc(100%-0.5rem)]")}
          onClick={leaveCopyMode}
        >
          Leave copy mode to type
        </button>
      )}
      <div
        className={cn(
          "flex max-h-40 items-stretch overflow-y-auto",
          !moreOpen && "hidden",
        )}
      >
        <div className="flex flex-1 flex-wrap items-center gap-1 px-1 py-1">
          <button
            className={cn(keyClass, "px-3")}
            aria-pressed={navigation}
            onClick={() => {
              useTerminalInput.getState().reset();
              onBlurTerminal();
              setNavigation(!navigation);
              setMoreOpen(false);
            }}
          >
            {navigation ? "Typing mode" : "Navigation mode"}
          </button>
          <button
            className={cn(keyClass, "px-3")}
            disabled={!connected || !activeSessionId}
            onClick={() => {
              onBlurTerminal();
              setMoreOpen(false);
              useUiStore.getState().setFabOpen(true);
            }}
          >
            Tmux actions
          </button>
          <RecentPhotos />
          {coreKey("ctrl")}
          <button
            className={iconBtnClass}
            aria-label="Open copy mode"
            disabled={!connected}
            onClick={() => {
              useTerminalInput.getState().reset();
              if (hapticEnabled) triggerHaptic();
              useUiStore.getState().setCopyModeOpen(true);
            }}
          >
            <ClipboardCopy className="h-4 w-4" />
          </button>

          <button
            data-terminal-key
            className={iconBtnClass}
            aria-label="Send Ctrl+C"
            disabled={!connected}
            onClick={() => sendSignal("\x03")}
          >
            <span className="text-xs font-medium">^C</span>
          </button>
          <button
            data-terminal-key
            className={iconBtnClass}
            aria-label="Send Ctrl+D"
            disabled={!connected}
            onClick={() => sendSignal("\x04")}
          >
            <span className="text-xs font-medium">^D</span>
          </button>
          <button
            data-terminal-key
            className={iconBtnClass}
            aria-label="Send Ctrl+Z"
            disabled={!connected}
            onClick={() => sendSignal("\x1a")}
          >
            <span className="text-xs font-medium">^Z</span>
          </button>

          {visibleKeys.map((key) => {
            const isSticky =
              (key.id === "ctrl" && stickyCtrl) ||
              (key.id === "alt" && stickyAlt);

            return (
              <button
                key={key.id}
                data-terminal-key
                className={cn(
                  "flex h-11 min-w-11 shrink-0 items-center justify-center rounded-md border px-2 text-xs font-medium transition-colors select-none",
                  "active:bg-accent/80 active:scale-95 disabled:opacity-40 disabled:active:scale-100",
                  "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                  isSticky
                    ? "border-primary bg-primary/20 text-primary"
                    : "border-border bg-background text-foreground",
                )}
                disabled={!connected}
                aria-pressed={
                  key.id === "ctrl" || key.id === "alt" ? isSticky : undefined
                }
                onClick={() => handleKeyPress(key.id, key.key)}
              >
                {key.label}
              </button>
            );
          })}

          {onSearchOpen && (
            <button
              className={iconBtnClass}
              onClick={() => {
                useTerminalInput.getState().reset();
                onSearchOpen();
              }}
              aria-label="Search"
            >
              <Search className="h-4 w-4" />
            </button>
          )}

          <button
            className={iconBtnClass}
            aria-label="Command palette"
            onClick={() => {
              useTerminalInput.getState().reset();
              useCommandStore.getState().setPaletteOpen(true);
            }}
          >
            <Zap className="h-4 w-4" />
          </button>
          <button
            className={iconBtnClass}
            aria-label="Paste"
            disabled={!connected}
            onClick={async () => {
              useTerminalInput.getState().reset();
              if (hapticEnabled) triggerHaptic();
              try {
                const text = await navigator.clipboard.readText();
                if (text) {
                  const client = getRelayClient();
                  client?.send({ type: "terminal:input", data: text });
                }
              } catch {
                useAlertStore
                  .getState()
                  .push("error", "Clipboard access denied");
              }
            }}
          >
            <ClipboardPaste className="h-4 w-4" />
          </button>
          {onCopy && (
            <button
              className={iconBtnClass}
              aria-label="Copy"
              onClick={() => {
                if (hapticEnabled) triggerHaptic();
                onCopy();
              }}
            >
              <Clipboard className="h-4 w-4" />
            </button>
          )}

          <button
            className={iconBtnClass}
            aria-label="Split horizontally"
            disabled={!connected}
            onClick={() => {
              getRelayClient()?.send({ type: "pane:split", direction: "h" });
              if (useSettingsStore.getState().autoZoom) {
                usePaneStore.getState().setPendingAutoZoom(true);
              }
              if (hapticEnabled) triggerHaptic();
            }}
          >
            <Columns2 className="h-4 w-4" />
          </button>

          <button
            className={iconBtnClass}
            aria-label="Split vertically"
            disabled={!connected}
            onClick={() => {
              getRelayClient()?.send({ type: "pane:split", direction: "v" });
              if (useSettingsStore.getState().autoZoom) {
                usePaneStore.getState().setPendingAutoZoom(true);
              }
              if (hapticEnabled) triggerHaptic();
            }}
          >
            <Rows2 className="h-4 w-4" />
          </button>

          <button
            className={iconBtnClass}
            aria-label="Decrease font size"
            onClick={() => {
              const { fontSize, setFontSize } = useTerminalStore.getState();
              setFontSize(Math.max(8, fontSize - 1));
              if (hapticEnabled) triggerHaptic();
            }}
          >
            <ZoomOut className="h-4 w-4" />
          </button>
          <button
            className={iconBtnClass}
            aria-label="Increase font size"
            onClick={() => {
              const { fontSize, setFontSize } = useTerminalStore.getState();
              setFontSize(Math.min(24, fontSize + 1));
              if (hapticEnabled) triggerHaptic();
            }}
          >
            <ZoomIn className="h-4 w-4" />
          </button>
        </div>

        <div className="flex shrink-0 items-center gap-0.5 border-l border-border px-1">
          <button
            className={iconBtnClass}
            aria-label="More keys"
            aria-expanded={keySheetOpen}
            onClick={() => {
              useTerminalInput.getState().reset();
              if (hapticEnabled) triggerHaptic();
              setKeySheetOpen(true);
            }}
          >
            <MoreHorizontal className="h-4 w-4" />
          </button>
          <button
            className={iconBtnClass}
            aria-label="Gestures and shortcuts"
            aria-expanded={helpOpen}
            onClick={() => {
              useTerminalInput.getState().reset();
              if (hapticEnabled) triggerHaptic();
              setHelpOpen(true);
            }}
          >
            <HelpCircle className="h-4 w-4" />
          </button>
        </div>
      </div>
      <KeySheet open={keySheetOpen} onOpenChange={setKeySheetOpen} />
      <GestureHelpSheet open={helpOpen} onOpenChange={setHelpOpen} />
    </div>
  );
}
