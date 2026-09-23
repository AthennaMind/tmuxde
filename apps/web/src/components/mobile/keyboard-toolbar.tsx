"use client";

import { useState, useCallback } from "react";
import {
  Search,
  Type,
  X,
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
import { KeySheet } from "./key-sheet";
import { GestureHelpSheet } from "./gesture-help-sheet";

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
  const [helpOpen, setHelpOpen] = useState(false);
  // Keys that travel to the relay are dead while the socket is down; the purely
  // local ones (search, palette, font size) stay live.
  const connected = useConnectionStore((s) => s.status === "connected");
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const inCopyMode = useBelievedInCopyMode(activeSessionId);
  const openComposer = useUiStore((s) => s.openComposer);

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

  const leaveCopyMode = useCallback(() => {
    noteLeftCopyMode(activeSessionId);
    getRelayClient()?.send({ type: "tmux:exit-copy-mode" });
    if (hapticEnabled) triggerHaptic();
  }, [activeSessionId, hapticEnabled]);

  const iconBtnClass =
    "flex h-11 w-11 shrink-0 items-center justify-center rounded-md border border-border bg-background text-foreground transition-colors active:bg-accent/80 active:scale-95 disabled:opacity-40 disabled:active:scale-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

  const visibleKeys = toolbarKeys.filter((k) => k.visible);

  return (
    <div className={cn("flex items-stretch", className)}>
      {/*
        The start of the bar, pinned.

        Everything in the strip beside it can be scrolled past, and on a 390px
        phone most of it is. What sits here is whichever thing the user most
        needs *right now*, which is not the same button in both states:

         - In tmux's own copy mode it is the way out, and it is the reason this
           zone exists. Keystrokes sent to a pane in copy mode are copy-mode
           commands, so until this is tapped the terminal looks focused and
           silently eats everything typed — including anything sent from the
           composer. A way out that can scroll off the edge of the screen is
           not a way out.
         - Otherwise it is the composer: writing a command is the most common
           thing anyone does down here, and it is purely local, so it stays
           live while the socket is down — that is how you have a command ready
           for when it comes back.

        Copy mode's *entrance* sits at the head of the strip instead, in the
        first slot a thumb reaches, wearing a clipboard rather than a scroll:
        on a phone it is the only way to get text out of the terminal at all —
        the rendered pane is a WebGL canvas, so there is nothing to
        press-and-hold — and an icon nobody recognises is a feature nobody has.
      */}
      <div className="flex shrink-0 items-center border-r border-border px-1">
        {inCopyMode ? (
          <button
            className="flex h-11 shrink-0 items-center gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/15 px-2.5 text-xs font-medium text-amber-600 transition-transform active:scale-95 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring dark:text-amber-400"
            aria-label="Leave copy mode"
            onClick={leaveCopyMode}
          >
            Copy mode
            <X className="h-3.5 w-3.5" />
          </button>
        ) : (
          <button
            className={iconBtnClass}
            aria-label="Write a command"
            onClick={() => {
              if (hapticEnabled) triggerHaptic();
              openComposer();
            }}
          >
            <Type className="h-4 w-4" />
          </button>
        )}
      </div>

      <div className="flex flex-1 items-center gap-0.5 overflow-x-auto px-1 py-1 scrollbar-none">
        {/*
          Copy mode, at the head of the strip.

          It is the first thing in the scrolling row and the first thing a
          thumb reaches, because on a phone it is the only way to get text out
          of the terminal: the pane is a WebGL canvas with no text to
          press-and-hold, and the long press over it means "this pane's
          options" instead. It wears a clipboard rather than a scroll for the
          reason it moved out here at all — the old icon was accurate about
          what the view is and told nobody what it is *for*.

          Gated on the socket, unlike the composer: the view it opens is filled
          from a `capture-pane` that has to travel.
        */}
        <button
          className={iconBtnClass}
          aria-label="Open copy mode"
          disabled={!connected}
          onClick={() => {
            if (hapticEnabled) triggerHaptic();
            useUiStore.getState().setCopyModeOpen(true);
          }}
        >
          <ClipboardCopy className="h-4 w-4" />
        </button>

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

        {/*
          Ways to *go* somewhere come before ways to *do* something to the
          current pane. Search and the palette each change what the screen is
          showing, and they were sitting behind five keys and two clipboard
          buttons — on a 390px phone, past the fold of a strip most people never
          realise scrolls. Copy mode used to be the third of them and is now
          pinned outside this strip entirely. The splits and the font size moved
          to the end instead: both are in the FAB, the splits are also in a
          pane's long-press menu, and the font size is a pinch.
        */}
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
        in this row can be scrolled past; the ways to reach what is *not* in the
        row cannot be — and there are two of those, which is why this zone holds
        two buttons and the other end holds one.

        `?` earns its 44px because most of this app is gestures, and a gesture
        has no label. A press, a pinch and a drag each do something useful on
        the terminal above and none of them says so; before this there was no
        surface anywhere that admitted they existed.
      */}
      <div className="flex shrink-0 items-center gap-0.5 border-l border-border px-1">
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
        <button
          className={iconBtnClass}
          aria-label="Gestures and shortcuts"
          aria-expanded={helpOpen}
          onClick={() => {
            if (hapticEnabled) triggerHaptic();
            setHelpOpen(true);
          }}
        >
          <HelpCircle className="h-4 w-4" />
        </button>
      </div>

      <KeySheet open={keySheetOpen} onOpenChange={setKeySheetOpen} />
      <GestureHelpSheet open={helpOpen} onOpenChange={setHelpOpen} />
    </div>
  );
}
