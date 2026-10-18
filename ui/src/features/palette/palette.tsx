import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Command } from "cmdk";
import { ChevronRight, FileSearch, Loader2, TextSearch, X } from "lucide-react";
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
  Dialog,
  DialogClose,
  DialogContentRaw,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
} from "@/components/ui/dialog";
import { getTerminalHandle } from "@/features/terminal/terminal-handle";
import { cn } from "@/shared/utils";
import { isMobileViewport } from "@/shared/mobile-query";
import { modKey, type PaletteMode } from "./palette-key";
import { sendCommand } from "@/features/terminal/send-command";
import { closePalette, usePaletteStore } from "./palette-store";
import { isReadOnly, useConnectionStore } from "@/features/connection/connection-store";
import { useSessionStore } from "@/features/session/session-store";
import { searchTerminals, useTerminalSearchStore } from "@/features/terminal/terminal-search-store";
import { CONTROL_CLASS, Kbd, PaletteFooter } from "./palette-primitives";
import { PaletteContext } from "./palette-context";
import { CommandsMode } from "./commands-mode";
import { FilesMode } from "./files-mode";
import { TerminalsMode } from "./terminals-mode";

const MODES: {
  id: PaletteMode;
  label: string;
  icon: typeof ChevronRight;
  keys: string;
  title: string;
  placeholder: string;
}[] = [
  {
    id: "commands",
    label: "Commands",
    icon: ChevronRight,
    keys: "K",
    title: "Command palette",
    placeholder: "Type a command or search…",
  },
  {
    id: "files",
    label: "Files",
    icon: FileSearch,
    keys: "P",
    title: "Find files",
    placeholder: "Find a file…",
  },
  {
    id: "terminals",
    label: "Terminals",
    icon: TextSearch,
    keys: "⇧F",
    title: "Search terminals",
    placeholder: "Search terminal history…",
  },
];

/**
 * One dialog for commands, files and terminal history.
 *
 * Content mounts on open and unmounts on close, so every opening starts from
 * a clean query and the exit is instant. A confirmation for a destructive
 * command shows after the palette has gone.
 */
export function Palette() {
  const open = usePaletteStore((s) => s.open);
  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!next) closePalette();
        }}
      >
        {open && <PaletteDialog />}
      </Dialog>
      <PaletteConfirm />
    </>
  );
}

function PaletteDialog() {
  const mode = usePaletteStore((s) => s.mode);
  const prompt = usePaletteStore((s) => s.prompt);
  const [query, setQuery] = useState(() =>
    mode === "terminals" ? useTerminalSearchStore.getState().query : "",
  );
  const [caseSensitive, setCaseSensitive] = useState(
    () => useTerminalSearchStore.getState().caseSensitive,
  );
  const [promptValue, setPromptValue] = useState("");
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  // Read at mount, before any focus moves into the dialog.
  const [opener] = useState(() =>
    document.activeElement instanceof HTMLElement ? document.activeElement : null,
  );
  const after = useRef<"terminal" | null>(null);
  const [seenMode, setSeenMode] = useState(mode);
  const [seenPrompt, setSeenPrompt] = useState(prompt);

  // Reset during render, not in an effect. A key pressed right after the
  // shortcut would otherwise read the old text and put it back.
  if (seenMode !== mode) {
    setSeenMode(mode);
    setQuery(mode === "terminals" ? useTerminalSearchStore.getState().query : "");
  }
  if (seenPrompt !== prompt) {
    setSeenPrompt(prompt);
    setPromptValue(prompt?.initial ?? "");
    // Back from a prompt, the text that found the command has done its job.
    if (!prompt) setQuery("");
  }

  // A restored search or a current name is selected, so typing replaces it.
  const focusInput = () => {
    const element = input.current;
    if (!element) return;
    element.focus();
    if (prompt?.initial || (mode === "terminals" && element.value)) element.select();
  };
  // Radix focuses on open. Later mode and prompt changes refocus here.
  const mounted = useRef(false);
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    focusInput();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, prompt]);

  const current = MODES.find((entry) => entry.id === mode) ?? MODES[0]!;
  const Icon = current.icon;
  const setMode = (next: PaletteMode) => usePaletteStore.setState({ mode: next, prompt: null });
  const finish = (focus?: "terminal") => {
    after.current = focus ?? null;
    closePalette();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (prompt) {
      if (event.key === "Enter") {
        event.preventDefault();
        const text = promptValue.trim();
        if (!text) return;
        prompt.submit(text);
        finish("terminal");
      } else if (event.key === "Backspace" && !promptValue) {
        event.preventDefault();
        usePaletteStore.setState({ prompt: null });
      }
      return;
    }
    if (event.key !== "Enter") return;
    if (mode === "terminals" && !event.ctrlKey && !event.metaKey) {
      const search = useTerminalSearchStore.getState();
      const stale =
        !search.requestId || search.query !== query || search.caseSensitive !== caseSensitive;
      if (stale && query.trim()) {
        event.preventDefault();
        searchTerminals(query, caseSensitive);
      }
      return;
    }
    if (mode === "commands" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      if (!canType() || !sendCommand(query)) return;
      finish("terminal");
    }
  };

  return (
    <PaletteContext.Provider value={{ query, finish, setMode, setBusy }}>
      <DialogPortal>
        <DialogOverlay className="bg-black/70 backdrop-blur-sm duration-150 motion-reduce:animate-none" />
        <DialogContentRaw
          data-palette=""
          aria-label={current.title}
          aria-describedby={undefined}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            focusInput();
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (after.current === "terminal") {
              if (!isMobileViewport()) getTerminalHandle()?.focus();
            } else if (opener?.isConnected) {
              opener.focus();
            }
          }}
          onEscapeKeyDown={(event) => {
            // Escape leaves a prompt first and closes on the second press.
            if (!usePaletteStore.getState().prompt) return;
            event.preventDefault();
            usePaletteStore.setState({ prompt: null });
          }}
          className={cn(
            "fixed inset-x-3 z-[var(--z-modal)] flex flex-col overflow-hidden rounded-[1.375rem] bg-surface-base font-sans text-foreground shadow-float ring-1 ring-foreground/10 outline-none",
            "top-[var(--palette-top)] h-[calc(var(--vv-height,100dvh)_-_var(--palette-top)_-_0.75rem)] [--palette-top:calc(var(--vv-offset-top,0px)_+_max(0.75rem,env(safe-area-inset-top)))]",
            "sm:inset-x-auto sm:left-1/2 sm:top-1/2 sm:h-[min(32rem,calc(100dvh_-_4rem))] sm:w-[40rem] sm:max-w-[calc(100vw-3rem)] sm:-translate-x-1/2 sm:-translate-y-1/2",
            "duration-150 ease-out data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 motion-reduce:animate-none",
          )}
        >
          <DialogTitle className="sr-only">{current.title}</DialogTitle>
          <Command
            label={current.title}
            shouldFilter={false}
            loop
            vimBindings={false}
            onKeyDown={onKeyDown}
            className="flex min-h-0 flex-1 flex-col"
          >
            <div className="shrink-0 border-b border-foreground/10">
              <div className="flex h-14 items-center gap-3 pe-2 ps-4">
                {prompt ? (
                  <span className="shrink-0 rounded-md bg-accent px-2 py-1 text-xs font-medium text-accent-foreground">
                    {prompt.label}
                  </span>
                ) : busy ? (
                  <Loader2
                    className="size-5 shrink-0 animate-spin text-primary motion-reduce:animate-none"
                    aria-hidden
                  />
                ) : (
                  <Icon className="size-5 shrink-0 text-muted-foreground" aria-hidden />
                )}
                <Command.Input
                  ref={input}
                  value={prompt ? promptValue : query}
                  onValueChange={prompt ? setPromptValue : setQuery}
                  placeholder={prompt?.placeholder ?? current.placeholder}
                  maxLength={256}
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  enterKeyHint={mode === "terminals" ? "search" : "go"}
                  className="h-full min-w-0 flex-1 bg-transparent text-base text-foreground outline-none placeholder:text-muted-foreground"
                />
                {mode === "terminals" && !prompt && (
                  <button
                    type="button"
                    aria-pressed={caseSensitive}
                    aria-label="Match case"
                    title="Match case"
                    onClick={() => {
                      setCaseSensitive((value) => !value);
                      input.current?.focus();
                    }}
                    className={cn(
                      "flex size-10 shrink-0 items-center justify-center rounded-xl font-mono text-sm",
                      CONTROL_CLASS,
                      caseSensitive
                        ? "bg-accent text-accent-foreground"
                        : "text-muted-foreground hover:bg-accent hover:text-foreground",
                    )}
                  >
                    Aa
                  </button>
                )}
                <Kbd className="hidden sm:inline-flex">esc</Kbd>
                <DialogClose
                  aria-label="Close"
                  className={cn(
                    "flex size-11 shrink-0 items-center justify-center rounded-xl text-muted-foreground hover:bg-accent hover:text-foreground sm:hidden",
                    CONTROL_CLASS,
                  )}
                >
                  <X className="size-5" aria-hidden />
                </DialogClose>
              </div>
              {!prompt && (
                <div
                  role="group"
                  aria-label="Search in"
                  className="flex items-center gap-1 px-3 pb-2.5"
                >
                  {MODES.map((entry) => {
                    const active = entry.id === mode;
                    return (
                      <button
                        key={entry.id}
                        type="button"
                        aria-pressed={active}
                        title={modKey(entry.keys)}
                        onClick={() => setMode(entry.id)}
                        className={cn(
                          "flex min-h-8 items-center gap-1.5 rounded-full px-3 text-xs font-medium",
                          CONTROL_CLASS,
                          active
                            ? "bg-accent text-accent-foreground"
                            : "text-muted-foreground hover:bg-accent hover:text-foreground",
                        )}
                      >
                        <entry.icon className="size-3.5" aria-hidden />
                        {entry.label}
                        <Kbd aria-hidden className="hidden sm:inline-flex">
                          {modKey(entry.keys)}
                        </Kbd>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
            {prompt ? (
              <>
                <Command.List className="min-h-0 flex-1">
                  <p className="px-4 py-6 text-sm text-muted-foreground">{prompt.hint}</p>
                </Command.List>
                <PaletteFooter
                  right={[
                    ["↵", prompt.label.toLowerCase()],
                    ["esc", "back"],
                  ]}
                />
              </>
            ) : mode === "commands" ? (
              <CommandsMode />
            ) : mode === "files" ? (
              <FilesMode />
            ) : (
              <TerminalsMode caseSensitive={caseSensitive} />
            )}
          </Command>
        </DialogContentRaw>
      </DialogPortal>
    </PaletteContext.Provider>
  );
}

function canType(): boolean {
  const connection = useConnectionStore.getState();
  return (
    connection.status === "connected" &&
    !isReadOnly(connection.capabilities) &&
    !!useSessionStore.getState().activeSessionId
  );
}

function PaletteConfirm() {
  const confirm = usePaletteStore((s) => s.confirm);
  const clear = () => usePaletteStore.setState({ confirm: null });
  return (
    <AlertDialog
      open={confirm !== null}
      onOpenChange={(open) => {
        if (!open) clear();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{confirm?.title}</AlertDialogTitle>
          <AlertDialogDescription>{confirm?.description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            onClick={() => {
              confirm?.run();
              clear();
            }}
          >
            {confirm?.label}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
