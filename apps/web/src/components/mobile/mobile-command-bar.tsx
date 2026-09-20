"use client";

import { useState, useRef, useCallback } from "react";
import { SendHorizonal, Maximize2 } from "lucide-react";
import { cn } from "@repo/ui/lib/utils";
import { triggerHaptic } from "@repo/ui/components/haptic-button";
import { useSettingsStore } from "@/stores/settings-store";
import { useConnectionStore } from "@/stores/connection-store";
import { useUiStore } from "@/stores/ui-store";
import { sendCommand } from "@/lib/send-command";
import { DictateButton } from "./dictate-button";

interface MobileCommandBarProps {
  className?: string;
}

/**
 * The one-line command bar above the keyboard toolbar.
 *
 * It used to auto-grow to four rows, which on a phone with the keyboard up
 * meant a terminal squeezed into a couple of hundred pixels by its own input.
 * It is now arithmetically one line — `h-11` is `py-[10px]`×2 plus `leading-6`
 * — with no measuring effect and nothing that can push it taller.
 *
 * Still a `<textarea>` rather than an `<input>`, and that matters: `<input>`
 * silently strips CR and LF from its value, and `sendCommand` needs to *see*
 * newlines to decide whether to wrap a block in bracketed paste. `wrap="off"`
 * gives it `white-space: pre` and horizontal scrolling — input behaviour —
 * while the value can still hold a `\n` from a paste.
 *
 * Ctrl+C, Tab and ↑ used to live here and have moved out. They duplicated
 * `KeyboardToolbar` 46px below, and ↑ in particular was actively confusing: it
 * sent `\x1b[A` to the *pty*, so it recalled shell history while the field it
 * sat inside stayed empty.
 */
export function MobileCommandBar({ className }: MobileCommandBarProps) {
  const [command, setCommand] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const { hapticEnabled } = useSettingsStore();
  // Sending into a dead socket used to clear the input anyway, so the command
  // vanished with no feedback.
  const connected = useConnectionStore((s) => s.status === "connected");
  const openComposer = useUiStore((s) => s.openComposer);

  const handleSend = useCallback(() => {
    if (!sendCommand(command)) return;
    if (hapticEnabled) triggerHaptic();
    setCommand("");
    inputRef.current?.focus();
  }, [command, hapticEnabled]);

  /**
   * A pasted block goes to the composer with its newlines intact.
   *
   * The alternative is collapsing it to one line, which silently changes what
   * the user pasted, or leaving it in a one-line field where they cannot see
   * what they are about to run. The composer is exactly the surface for
   * reviewing several lines before sending them.
   */
  const handlePaste = useCallback(
    (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const text = e.clipboardData.getData("text");
      if (!text.includes("\n")) return;
      e.preventDefault();
      openComposer(command ? `${command}\n${text}` : text);
      setCommand("");
    },
    [command, openComposer],
  );

  return (
    <div
      className={cn(
        "flex items-center gap-1.5 border-t bg-background px-2 py-1.5",
        className,
      )}
    >
      <button
        onClick={() => openComposer(command)}
        className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground transition-transform focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring active:scale-95"
        aria-label="Open the command composer"
      >
        <Maximize2 className="h-3.5 w-3.5" />
      </button>
      <textarea
        ref={inputRef}
        value={command}
        onChange={(e) => setCommand(e.target.value)}
        onPaste={handlePaste}
        onKeyDown={(e) => {
          // An IME's confirm-candidate Enter is not a send. Without this guard
          // a Japanese or Chinese keyboard fires a half-composed command at
          // the shell the moment the user picks a character.
          if (e.nativeEvent.isComposing) return;
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            handleSend();
          }
        }}
        rows={1}
        wrap="off"
        // Deliberately *not* disabled while disconnected: a reconnect takes a
        // few seconds and throwing away what someone typed during it is worse
        // than a Send button they have to press again. Only Send is disabled.
        placeholder={connected ? "Type a command…" : "Reconnecting…"}
        className={cn(
          // `text-[16px]`, not `text-base`. `text-base` is 1rem and tracks the
          // browser's default font size, so a user who has set 14px still gets
          // iOS's zoom-on-focus. Fixing that with `maximum-scale=1` instead
          // would violate WCAG 1.4.4 and break PinchZoomHandler.
          "h-11 flex-1 resize-none overflow-x-auto rounded-md border border-border bg-muted/50 px-3 py-[10px] font-mono text-[16px] leading-6 outline-none transition-colors focus:border-primary focus:ring-1 focus:ring-primary",
          // Load-bearing: a textarea's intrinsic `cols` width otherwise pushes
          // the send button off the right edge of a narrow phone.
          "min-w-0",
        )}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        enterKeyHint="send"
        aria-label="Command"
      />
      {/* Below 360px there is no room for four controls, and dictation is
          still reachable inside the composer. */}
      <DictateButton
        className="hidden min-[360px]:flex"
        onFinal={(text) =>
          setCommand((current) => (current ? `${current} ${text}` : text))
        }
      />
      <button
        onClick={handleSend}
        disabled={!connected || !command.trim()}
        aria-label="Send command"
        /*
         * Why it is greyed out, in the one place someone will look.
         *
         * A disabled control with no explanation is a dead end: the user
         * cannot tell whether it is broken, not ready, or not for them. There
         * are exactly two reasons this button is off and they call for
         * different actions — wait, or type something.
         */
        title={
          !connected
            ? "Not connected — reconnecting"
            : !command.trim()
              ? "Type a command to send"
              : "Send command"
        }
        className={cn(
          "flex h-11 w-11 shrink-0 items-center justify-center rounded-md transition-colors",
          "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
          connected && command.trim()
            ? "bg-primary text-primary-foreground active:scale-95"
            : "bg-muted text-muted-foreground",
        )}
      >
        <SendHorizonal className="h-4 w-4" />
      </button>
    </div>
  );
}
