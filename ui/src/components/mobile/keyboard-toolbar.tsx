import { useState, useCallback, useEffect, useRef } from "react";
import { Keyboard, SlidersHorizontal } from "lucide-react";
import { cn } from "@/lib/utils";
import { triggerHaptic } from "@/components/haptic-button";
import { useSettingsStore } from "@/stores/settings-store";
import { useConnectionStore } from "@/stores/connection-store";
import { useSessionStore } from "@/stores/session-store";
import { useBelievedInCopyMode } from "@/hooks/use-copy-mode";
import { leaveCopyMode } from "@/lib/terminal-scroll";
import { sendKeySequence } from "@/lib/send-key";
import { consumeTerminalInput, useTerminalInput } from "@/lib/terminal-input.js";
import { NavigationToolbar } from "./navigation-toolbar";
import { TerminalControls } from "./terminal-controls";
import { DictationButton, useDictationAvailable } from "@/components/dictation/dictation-button";
import { GestureHelpSheet } from "./gesture-help-sheet";
import { useUiStore } from "@/stores/ui-store";

interface KeyboardToolbarProps {
  className?: string;
  onSearchOpen?: () => void;
  onCopy?: () => void;
  onFocusTerminal: () => void;
  onBlurTerminal: () => void;
}

const keyClass =
  "flex h-11 min-w-0 items-center justify-center rounded-xl bg-surface-panel px-1 text-xs font-medium text-foreground active:bg-surface-hover disabled:opacity-40 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring";

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
  const [controlsOpen, setControlsOpen] = useState(false);
  const [typing, setTyping] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const controlsTrigger = useRef<HTMLButtonElement>(null);
  const connected = useConnectionStore((s) => s.status === "connected");
  const session = useSessionStore((s) => s.activeSessionId);
  const inCopyMode = useBelievedInCopyMode(session);
  const dictation = useDictationAvailable();
  const disabled = !connected || !session;

  useEffect(() => {
    const sync = () =>
      setTyping(document.activeElement?.classList.contains("xterm-helper-textarea") ?? false);
    document.addEventListener("focusin", sync);
    document.addEventListener("focusout", sync);
    return () => {
      document.removeEventListener("focusin", sync);
      document.removeEventListener("focusout", sync);
    };
  }, []);

  useEffect(() => {
    useTerminalInput.getState().reset();
    setControlsOpen(false);
    return () => useTerminalInput.getState().reset();
  }, [connected, session]);

  const sendKey = useCallback(
    (key: string, focus = true) => {
      if (sendKeySequence(consumeTerminalInput(key)) && focus) onFocusTerminal();
    },
    [onFocusTerminal],
  );

  const openControls = () => {
    useTerminalInput.getState().reset();
    onBlurTerminal();
    setControlsOpen(true);
  };

  const coreKey = (id: string) => {
    const key = toolbarKeys.find((entry) => entry.id === id);
    if (!key) return null;
    const pressed = id === "ctrl" ? stickyCtrl : id === "alt" ? stickyAlt : undefined;
    const names: Record<string, string> = {
      left: "Arrow left",
      down: "Arrow down",
      up: "Arrow up",
      right: "Arrow right",
    };
    return (
      <button
        key={id}
        type="button"
        data-terminal-key
        disabled={disabled}
        aria-label={names[id] ?? key.label}
        aria-pressed={pressed}
        className={cn(
          keyClass,
          pressed && "bg-brand-subtle text-primary ring-1 ring-inset ring-primary",
        )}
        onClick={() => {
          if (id === "ctrl" || id === "alt") {
            onFocusTerminal();
            useTerminalInput.getState().toggle(id);
            if (hapticEnabled) triggerHaptic(20);
          } else sendKey(key.key, !names[id]);
        }}
      >
        {key.label}
      </button>
    );
  };

  return (
    <div
      className={cn("tmuxde-keyboard font-sans", className)}
      onPointerDown={(event) => {
        if ((event.target as HTMLElement).closest("button[data-terminal-key]"))
          event.preventDefault();
      }}
    >
      {navigation ? (
        <NavigationToolbar
          onMore={openControls}
          controlsTrigger={controlsTrigger}
          controlsOpen={controlsOpen}
          onKeyboard={() => {
            setNavigation(false);
            onFocusTerminal();
          }}
        />
      ) : (
        <div
          role="group"
          aria-label="Terminal keyboard"
          className="grid grid-cols-6 gap-1.5 px-2 pt-2 pb-1"
        >
          <button
            type="button"
            data-terminal-key
            className={cn(keyClass, typing && "bg-brand-subtle text-primary")}
            aria-label={typing ? "Hide keyboard" : "Show keyboard"}
            aria-pressed={typing}
            disabled={disabled}
            onClick={() => {
              if (typing) {
                useTerminalInput.getState().reset();
                onBlurTerminal();
              } else onFocusTerminal();
            }}
          >
            <Keyboard aria-hidden className="size-5" />
          </button>
          {coreKey("esc")}
          {coreKey("tab")}
          {coreKey("ctrl")}
          <button
            type="button"
            data-terminal-key
            className={cn(keyClass, "bg-brand-subtle text-primary")}
            disabled={disabled}
            onClick={() => sendKey("\r")}
          >
            Enter
          </button>
          <button
            ref={controlsTrigger}
            type="button"
            className={cn(keyClass, "flex-col gap-0.5")}
            aria-label="Terminal controls"
            aria-haspopup="dialog"
            aria-expanded={controlsOpen}
            onClick={openControls}
          >
            <SlidersHorizontal aria-hidden className="size-4" />
            <span>Tools</span>
          </button>
          {coreKey("alt")}
          {["left", "down", "up", "right"].map(coreKey)}
          {dictation ? (
            <DictationButton variant="toolbar" className="rounded-xl border-0 bg-surface-panel" />
          ) : (
            <button
              type="button"
              className={keyClass}
              aria-label="Write a command"
              onClick={() => {
                useTerminalInput.getState().reset();
                onBlurTerminal();
                useUiStore.getState().openComposer();
              }}
            >
              Draft
            </button>
          )}
        </div>
      )}
      {inCopyMode && (
        <button
          type="button"
          className={cn(keyClass, "mx-2 mb-1 w-[calc(100%-1rem)] bg-brand-subtle text-primary")}
          onClick={() => {
            useTerminalInput.getState().reset();
            leaveCopyMode();
          }}
        >
          Leave copy mode to type
        </button>
      )}
      <TerminalControls
        open={controlsOpen}
        onOpenChange={setControlsOpen}
        triggerRef={controlsTrigger}
        navigation={navigation}
        onNavigation={() => {
          setNavigation(!navigation);
          onBlurTerminal();
          requestAnimationFrame(() => controlsTrigger.current?.focus({ preventScroll: true }));
        }}
        onSearchOpen={onSearchOpen}
        onCopy={onCopy}
        onHelp={() => setHelpOpen(true)}
      />
      <GestureHelpSheet open={helpOpen} onOpenChange={setHelpOpen} />
    </div>
  );
}
