"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Dialog,
  DialogClose,
  DialogContentRaw,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
} from "@repo/ui/components/ui/dialog";
import { SendHorizonal, X } from "lucide-react";
import { cn } from "@repo/ui/lib/utils";
import { useMiniScrollbar } from "@repo/ui/components/ui/mini-scrollbar";
import { triggerHaptic } from "@repo/ui/components/haptic-button";
import { useCommandStore } from "@/stores/command-store";
import { useConnectionStore } from "@/stores/connection-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useUiStore } from "@/stores/ui-store";
import { sendCommand } from "@/lib/send-command";
import { isEnrolled } from "@/lib/unlocked";
import { DictateButton } from "./dictate-button";

/**
 * A full-height editor for commands that do not fit on one line.
 *
 * The one-line bar sends on Enter. This does not — Enter inserts a newline and
 * sending is the button only, and that asymmetry *is* the reason the composer
 * exists. A multi-line command is one you want to read before it runs, and the
 * Send button says "Send 3 lines" so the review is unavoidable rather than
 * optional.
 *
 * Built on Radix `Dialog` rather than the `fixed inset-0` pattern used
 * elsewhere in this directory. That pattern has no focus trap, no
 * `role="dialog"`, no `aria-modal` and no Escape handling; for a read-only pane
 * dump that is a minor gap, but for a text-entry surface layered over a live
 * pty it means tabbing off the end and typing into the shell behind an overlay
 * you cannot see.
 *
 * Sized to the visual viewport rather than `inset-0`, because `position: fixed`
 * sizes to the *layout* viewport and `interactiveWidget: "resizes-content"` is
 * Chromium-only — on iOS Safari `inset-0` renders the Send button underneath
 * the keyboard.
 */
export function CommandComposer() {
  const draft = useUiStore((s) => s.composerDraft);
  const setDraft = useUiStore((s) => s.setComposerDraft);
  const close = useUiStore((s) => s.closeComposer);
  const open = draft !== null;

  /**
   * Where focus goes when this closes.
   *
   * Radix restores focus itself, but only for content still mounted when the
   * close runs — and the body below is unmounted the instant `draft` becomes
   * null, so its `onCloseAutoFocus` never fires and focus falls to `<body>`.
   * What sits behind this dialog is a live pty, so a dropped focus means the
   * next keystroke goes to the shell.
   *
   * Tracked continuously *while closed* rather than sampled on open: effects in
   * the child run first, and Radix moves focus into the editor from one of
   * them, so anything sampled here after the open records the editor and then
   * finds it unmounted — the same dropped focus by a longer road.
   */
  const returnFocusTo = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (open) return;
    const remember = () => {
      const el = document.activeElement;
      if (el instanceof HTMLElement && el !== document.body) {
        returnFocusTo.current = el;
      }
    };
    remember();
    document.addEventListener("focusin", remember);
    return () => document.removeEventListener("focusin", remember);
  }, [open]);

  const wasOpen = useRef(open);
  useEffect(() => {
    const closing = wasOpen.current && !open;
    wasOpen.current = open;
    if (!closing) return;
    const target = returnFocusTo.current;
    // Deferred past the unmount, so the element is focusable again by the time
    // this runs and Radix's own teardown has finished moving focus about.
    if (target?.isConnected) requestAnimationFrame(() => target.focus());
  }, [open]);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      {open && <ComposerBody draft={draft} setDraft={setDraft} close={close} />}
    </Dialog>
  );
}

type Tab = "history" | "snippets";

function ComposerBody({
  draft,
  setDraft,
  close,
}: {
  draft: string;
  setDraft: (value: string) => void;
  close: () => void;
}) {
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const [tab, setTab] = useState<Tab>("history");
  // A 128px-tall raw scroller on a phone: nothing drew a bar, so a history
  // longer than four entries looked like a history of four entries.
  const { ref: entriesRef, scrollbar: entriesScrollbar } = useMiniScrollbar();
  const { history, snippets } = useCommandStore();
  const { hapticEnabled } = useSettingsStore();
  const connected = useConnectionStore((s) => s.status === "connected");
  const mobileTab = useUiStore((s) => s.mobileTab);

  /**
   * Android's Back button closes the composer instead of leaving the terminal.
   *
   * The entry must carry `mobileTab`, or `use-mobile-history` reads a popstate
   * with no tab in it and flips the tab as a side effect of the composer
   * closing — the user asked to dismiss a dialog and lands on a different
   * screen.
   */
  useEffect(() => {
    window.history.pushState({ mobileTab, overlay: "composer" }, "");
    const onPop = () => close();
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [close, mobileTab]);

  const lines = draft.trim() ? draft.trim().split("\n").length : 0;

  const send = useCallback(() => {
    if (!sendCommand(draft)) return;
    if (hapticEnabled) triggerHaptic();
    close();
  }, [draft, hapticEnabled, close]);

  /**
   * Insert at the caret, and never send.
   *
   * Tapping a history entry in the palette runs it. Here it must not: the whole
   * point of the surface is that you are assembling something before running
   * it, and a list that fires on touch is a list you cannot browse.
   */
  const insertAtCaret = useCallback(
    (text: string) => {
      const el = editorRef.current;
      if (!el) {
        setDraft(draft ? `${draft}\n${text}` : text);
        return;
      }
      const start = el.selectionStart ?? draft.length;
      const end = el.selectionEnd ?? draft.length;
      const next = draft.slice(0, start) + text + draft.slice(end);
      setDraft(next);
      requestAnimationFrame(() => {
        el.focus();
        const caret = start + text.length;
        el.setSelectionRange(caret, caret);
      });
    },
    [draft, setDraft],
  );

  const entries = tab === "history" ? history : snippets.map((s) => s.command);

  return (
    <DialogPortal>
      <DialogOverlay className="fixed inset-0 z-50 bg-black/60 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
      <DialogContentRaw
        aria-describedby={undefined}
        onOpenAutoFocus={(e: Event) => {
          // Focus the editor rather than the close button, which is what
          // someone who tapped "expand" was reaching for.
          e.preventDefault();
          editorRef.current?.focus();
        }}
        className={cn(
          "fixed z-50 flex flex-col bg-background",
          "data-[state=closed]:animate-out data-[state=closed]:slide-out-to-bottom",
          "data-[state=open]:animate-in data-[state=open]:slide-in-from-bottom",
        )}
        style={{
          left: "var(--vv-offset-left, 0px)",
          top: "var(--vv-offset-top, 0px)",
          width: "var(--vv-width, 100%)",
          height: "var(--vv-height, 100%)",
          /*
           * Self-correcting across both engines rather than branching on
           * platform. On Chromium `--vv-keyboard-inset` is non-zero and cancels
           * the safe-area inset, which the shrunk viewport has already
           * accounted for; on iOS the inset is what the home indicator needs.
           */
          paddingBottom:
            "max(0px, calc(env(safe-area-inset-bottom) - var(--vv-keyboard-inset, 0px)))",
        }}
      >
        <div className="flex items-center justify-between border-b px-3 py-2">
          <DialogTitle className="text-sm font-medium">Command</DialogTitle>
          <DialogClose
            className="flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            aria-label="Close the composer"
          >
            <X className="h-4 w-4" />
          </DialogClose>
        </div>

        <textarea
          ref={editorRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          // No Enter-to-send. See the note at the top of the file.
          placeholder="Write a command. Enter adds a line."
          className="min-h-0 flex-1 resize-none bg-transparent px-3 py-3 font-mono text-[16px] leading-6 outline-none"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          aria-label="Command"
        />

        <div className="border-t">
          <div className="flex items-center gap-1 px-2 pt-2" role="tablist">
            {(["history", "snippets"] as const).map((name) => (
              <button
                key={name}
                role="tab"
                aria-selected={tab === name}
                onClick={() => setTab(name)}
                className={cn(
                  "rounded-md px-3 py-1.5 text-xs capitalize transition-colors",
                  tab === name
                    ? "bg-muted text-foreground"
                    : "text-muted-foreground",
                )}
              >
                {name}
              </button>
            ))}
          </div>

          <div className="relative">
            {entriesScrollbar}
            <ul
              ref={entriesRef}
              className="max-h-32 overflow-y-auto px-2 py-2"
              aria-label={`${tab} entries`}
            >
              {entries.length === 0 ? (
                <li className="px-1 py-2 text-xs text-muted-foreground">
                  {emptyStateFor(tab)}
                </li>
              ) : (
                entries.map((entry, i) => (
                  <li key={`${entry}-${i}`}>
                    <button
                      onClick={() => insertAtCaret(entry)}
                      className="w-full truncate rounded px-1 py-1.5 text-left font-mono text-xs text-muted-foreground active:bg-muted"
                    >
                      {entry}
                    </button>
                  </li>
                ))
              )}
            </ul>
          </div>
        </div>

        <div className="flex items-center gap-2 border-t px-2 py-2">
          <DictateButton onFinal={insertAtCaret} />
          <button
            onClick={send}
            disabled={!connected || lines === 0}
            className={cn(
              "flex h-11 flex-1 items-center justify-center gap-2 rounded-md text-sm font-medium transition-colors",
              "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
              connected && lines > 0
                ? "bg-primary text-primary-foreground active:scale-[0.99]"
                : "bg-muted text-muted-foreground",
            )}
          >
            <SendHorizonal className="h-4 w-4" />
            {/* The label *is* the review affordance: "Send 3 lines" is the
                last chance to notice that a paste brought more than expected. */}
            {lines > 1 ? `Send ${lines} lines` : "Send"}
          </button>
        </div>
      </DialogContentRaw>
    </DialogPortal>
  );
}

/**
 * Why a list is empty, when "empty" can mean two different things.
 *
 * On a device with a lock enrolled, `command-store` stops persisting history
 * entirely — the last hundred commands are as revealing as the terminal itself.
 * So on a locked device this list is empty *by design*, and saying nothing
 * would leave it reading as broken.
 */
function emptyStateFor(tab: Tab): string {
  if (tab === "snippets") return "No snippets yet. Save one from the palette.";
  return isEnrolled()
    ? "History is not saved on a locked device."
    : "Nothing yet — commands you send appear here.";
}
