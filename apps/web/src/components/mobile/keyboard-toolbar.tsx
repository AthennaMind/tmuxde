"use client";

import { useState, useCallback } from "react";
import {
  Search,
  Zap,
  Columns2,
  Rows2,
  ScrollText,
  Clipboard,
  ClipboardPaste,
  ZoomIn,
  ZoomOut,
  MoreHorizontal,
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
import { sendKeySequence } from "@/lib/send-key";
import { KeySheet } from "./key-sheet";

interface KeyboardToolbarProps {
  className?: string;
  /** #6: Callback to trigger terminal search */
  onSearchOpen?: () => void;
  onCopy?: () => void;
}

export function KeyboardToolbar({
  className,
  onSearchOpen,
  onCopy,
}: KeyboardToolbarProps) {
  const toolbarKeys = useSettingsStore((s) => s.toolbarKeys);
  const hapticEnabled = useSettingsStore((s) => s.hapticEnabled);
  const [stickyCtrl, setStickyCtrl] = useState(false);
  const [stickyAlt, setStickyAlt] = useState(false);
  const [keySheetOpen, setKeySheetOpen] = useState(false);
  // Keys that travel to the relay are dead while the socket is down; the purely
  // local ones (search, palette, font size) stay live.
  const connected = useConnectionStore((s) => s.status === "connected");

  /**
   * Send a toolbar key, applying whichever sticky modifiers are lit.
   *
   * ## What the latch covers, and what it does not
   *
   * It covers **the keys in this row and the key sheet, only**. Anything typed
   * on the soft keyboard goes straight to xterm's own `onData` and never
   * passes through here, so tapping Ctrl and then typing `c` on the phone
   * keyboard sends a literal `c`. That is a real limitation, stated here
   * rather than left to be discovered.
   *
   * Ctrl is only defined for the ASCII range `@` through `_` (64–95), which
   * maps to control codes 0–31 — that is the whole of what a terminal can
   * express. Tab, the arrows, `⇧Tab` and `⌥⏎` are escape sequences with no
   * Ctrl form, so they are sent unchanged. Alt has no such limit: it is an
   * ESC prefix and composes with anything, including an escape sequence.
   *
   * Both latches clear after *any* key, whether or not the modifier could be
   * applied. Clearing them only inside the transform is what left the chip lit
   * indefinitely — `key.length === 1` is false for every multi-byte key in the
   * row, so neither branch ran and neither latch was ever released.
   */
  const sendKey = useCallback(
    (key: string) => {
      let data = key;

      if (stickyCtrl && key.length === 1) {
        const code = key.toUpperCase().charCodeAt(0);
        if (code >= 64 && code <= 95) {
          data = String.fromCharCode(code - 64);
        }
      }
      if (stickyAlt) {
        data = "\x1b" + data;
      }

      setStickyCtrl(false);
      setStickyAlt(false);
      sendKeySequence(data);
    },
    [stickyCtrl, stickyAlt],
  );

  const handleKeyPress = useCallback(
    (id: string, key: string) => {
      if (id === "ctrl") {
        setStickyCtrl((prev) => !prev);
        if (hapticEnabled) triggerHaptic(20);
        return;
      }
      if (id === "alt") {
        setStickyAlt((prev) => !prev);
        if (hapticEnabled) triggerHaptic(20);
        return;
      }
      sendKey(key);
    },
    [sendKey, hapticEnabled],
  );

  /* A long press on a key used to fire its own 30ms buzz after 500ms and then
     do nothing at all. A haptic distinct from the tap one is a promise that
     something is about to happen; there was never a variants popup behind it,
     so the buzz was the whole feature. Removed rather than left to keep
     promising. */

  /** Signals bypass the sticky-modifier path — they are already control codes. */
  const sendSignal = useCallback((data: string) => {
    sendKeySequence(data);
  }, []);

  const iconBtnClass =
    "flex h-11 w-11 shrink-0 items-center justify-center rounded-md border border-border bg-background text-foreground transition-colors active:bg-accent/80 active:scale-95 disabled:opacity-40 disabled:active:scale-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

  const visibleKeys = toolbarKeys.filter((k) => k.visible);

  return (
    <div className={cn("flex items-stretch", className)}>
      <div className="flex flex-1 items-center gap-0.5 overflow-x-auto px-1 py-1 scrollbar-none">
        {/* Signal buttons */}
        <button
          className={iconBtnClass}
          aria-label="Send Ctrl+C"
          disabled={!connected}
          onClick={() => sendSignal("\x03")}
        >
          <span className="text-xs font-medium">^C</span>
        </button>
        <button
          className={iconBtnClass}
          aria-label="Send Ctrl+D"
          disabled={!connected}
          onClick={() => sendSignal("\x04")}
        >
          <span className="text-xs font-medium">^D</span>
        </button>
        <button
          className={iconBtnClass}
          aria-label="Send Ctrl+Z"
          disabled={!connected}
          onClick={() => sendSignal("\x1a")}
        >
          <span className="text-xs font-medium">^Z</span>
        </button>

        {/*
          The configurable keys come before the icon actions, and that ordering
          is the whole point of the row on a phone. They used to be last, so on
          a 390px screen ⇧Tab and ⌥⏎ sat past eleven icon buttons — reachable
          only by scrolling a strip most people never realise scrolls.
        */}
        {visibleKeys.map((key) => {
          const isSticky =
            (key.id === "ctrl" && stickyCtrl) ||
            (key.id === "alt" && stickyAlt);

          return (
            <button
              key={key.id}
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

        <button
          className={iconBtnClass}
          aria-label="Paste"
          disabled={!connected}
          onClick={async () => {
            if (hapticEnabled) triggerHaptic();
            try {
              const text = await navigator.clipboard.readText();
              if (text) {
                const client = getRelayClient();
                client?.send({ type: "terminal:input", data: text });
              }
            } catch {
              useAlertStore.getState().push("error", "Clipboard access denied");
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
        {/* Search button */}
        {onSearchOpen && (
          <button
            className={iconBtnClass}
            onClick={onSearchOpen}
            aria-label="Search"
          >
            <Search className="h-4 w-4" />
          </button>
        )}
        {/* Command palette */}
        <button
          className={iconBtnClass}
          aria-label="Command palette"
          onClick={() => useCommandStore.getState().setPaletteOpen(true)}
        >
          <Zap className="h-4 w-4" />
        </button>
        {/* Split horizontal */}
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
        {/* Split vertical */}
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
        {/* Copy mode overlay */}
        <button
          className={iconBtnClass}
          aria-label="Open copy mode"
          disabled={!connected}
          onClick={() => {
            useUiStore.getState().setCopyModeOpen(true);
            if (hapticEnabled) triggerHaptic();
          }}
        >
          <ScrollText className="h-4 w-4" />
        </button>
        {/* Zoom controls */}
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

      {/*
        Outside the scrolling strip, so it is always on screen. Every other key
        in this row can be scrolled past; the way to reach the ones that are not
        in the row cannot be.
      */}
      <div className="flex shrink-0 items-center border-l border-border px-1">
        <button
          className={iconBtnClass}
          aria-label="More keys"
          aria-expanded={keySheetOpen}
          onClick={() => {
            if (hapticEnabled) triggerHaptic();
            setKeySheetOpen(true);
          }}
        >
          <MoreHorizontal className="h-4 w-4" />
        </button>
      </div>

      <KeySheet open={keySheetOpen} onOpenChange={setKeySheetOpen} />
    </div>
  );
}
