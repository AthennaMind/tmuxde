import { useEffect, useId, useRef, useState } from "react";
import { CircleAlert, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { chordKey, formatChord, type Chord } from "@/features/keybindings/chord";
import { chordSpeech } from "@/features/keybindings/chord-speech";
import { COMMAND_INFO, type CommandId } from "@/features/keybindings/command-ids";
import { BINDING_SCOPES, type BindingScope, type Keymap } from "@/features/keybindings/keymap";
import type { Platform } from "@/features/keybindings/platform";
import { pauseBindings } from "@/features/keybindings/recording-pause";
import { chordLabel } from "@/features/keybindings/shortcut-label";
import {
  SCOPE_LABELS,
  defaultScope,
  isBrowserReserved,
  recorderKey,
  shortcutConflicts,
  takesKeyFromShell,
  type ShortcutChange,
} from "@/features/keybindings/shortcut-edit";
import { cn } from "@/shared/utils";
import { Segmented, settingsFocus } from "./settings-rows";

export interface RecordedShortcut {
  chord: Chord;
  scope: BindingScope;
}

export interface RecorderError {
  text: string;
  /** A follow up, such as opening the keybindings file. */
  action?: { label: string; run: () => void };
}

interface Message {
  tone: "warning" | "info";
  text: string;
}

/**
 * Inline recorder for one command's shortcut.
 *
 * A read only input takes the next key press as the chord, so it has a
 * label and its value is announced. While it has focus the app's bindings
 * pause, else Ctrl+K would open the palette instead of being recorded.
 * Plain Tab still moves focus, plain Escape cancels and plain Enter saves.
 */
export function ShortcutRecorder({
  command,
  replacing,
  keymap,
  platform,
  saving,
  error,
  onSave,
  onCancel,
}: {
  command: CommandId;
  replacing?: ShortcutChange["replacing"];
  /** The resolved keymap, for conflict checks. */
  keymap: Keymap;
  platform: Platform;
  saving: boolean;
  error: RecorderError | null;
  onSave: (shortcut: RecordedShortcut) => void;
  onCancel: () => void;
}) {
  const [chord, setChord] = useState<Chord | null>(null);
  const [pickedScope, setPickedScope] = useState<BindingScope | null>(null);
  const [prompt, setPrompt] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const releaseRef = useRef<(() => void) | null>(null);
  const base = useId();
  const inputId = `${base}input`;
  const instructionsId = `${base}instructions`;
  const statusId = `${base}status`;
  const title = COMMAND_INFO[command].title;

  const hold = () => {
    if (!releaseRef.current) releaseRef.current = pauseBindings();
  };
  const release = () => {
    releaseRef.current?.();
    releaseRef.current = null;
  };

  useEffect(() => {
    const input = inputRef.current;
    input?.focus();
    // Strict mode runs this twice. The second focus sends no focus event.
    if (input && document.activeElement === input && !releaseRef.current) {
      releaseRef.current = pauseBindings();
    }
    return () => {
      releaseRef.current?.();
      releaseRef.current = null;
    };
  }, []);

  const scope =
    pickedScope ?? (chord ? defaultScope(chord, replacing) : (replacing?.scope ?? "global"));
  const same =
    !!chord && !!replacing && chordKey(chord) === replacing.chordKey && scope === replacing.scope;

  const messages: Message[] = [];
  if (chord) {
    const label = formatChord(chord, platform);
    if (same) messages.push({ tone: "info", text: "This is the current shortcut." });
    for (const other of shortcutConflicts(keymap, chord, scope, command)) {
      messages.push({
        tone: "warning",
        text: `${label} also runs ${COMMAND_INFO[other].title}. Your shortcut takes over where both apply.`,
      });
    }
    if (isBrowserReserved(chord, platform)) {
      messages.push({
        tone: "warning",
        text: `The browser keeps ${label} for itself. It may never reach this page.`,
      });
    }
    if (takesKeyFromShell(chord, scope)) {
      messages.push({
        tone: "warning",
        text: `Without ${platform === "mac" ? "Control, Option or Command" : "Ctrl, Alt or Meta"} this key fires while you type in the terminal. The shell no longer gets it.`,
      });
    }
  }

  const submit = () => {
    if (saving) return;
    if (!chord) {
      setPrompt(true);
      inputRef.current?.focus();
      return;
    }
    if (same) {
      onCancel();
      return;
    }
    onSave({ chord, scope });
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    const action = recorderKey(event.nativeEvent, chord !== null);
    if (action.kind === "pass") return;
    event.preventDefault();
    event.stopPropagation();
    if (action.kind === "cancel") onCancel();
    else if (action.kind === "save") submit();
    else if (action.kind === "chord") {
      setChord(action.chord);
      setPrompt(false);
    }
  };

  const scopeIds = {
    controlId: `${base}scope`,
    labelId: `${base}scopelabel`,
    hintId: undefined,
  };

  return (
    <div
      className="mt-3 space-y-3 rounded-lg border border-line-subtle bg-surface-sunken p-3"
      onKeyDown={(event) => {
        // Escape cancels from the scope picker and the buttons too. The
        // input handles its own and stops it there.
        if (event.key !== "Escape" || event.defaultPrevented) return;
        if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;
        event.preventDefault();
        onCancel();
      }}
    >
      {/* Top aligned, so both labels share a line over controls of different heights. */}
      <div className="flex flex-wrap items-start gap-x-6 gap-y-3">
        <div className="space-y-1.5">
          <label
            htmlFor={inputId}
            className="block text-[13px] font-medium leading-5 text-foreground"
          >
            New shortcut
          </label>
          <input
            ref={inputRef}
            id={inputId}
            readOnly
            value={chord ? formatChord(chord, platform) : ""}
            placeholder="Press keys"
            aria-describedby={`${instructionsId} ${statusId}`}
            onKeyDown={onKeyDown}
            onFocus={hold}
            onBlur={release}
            className={cn(
              "h-9 w-48 rounded-md border border-input bg-background px-3 font-mono text-sm text-foreground caret-transparent placeholder:font-sans placeholder:text-muted-foreground pointer-coarse:h-11",
              settingsFocus,
            )}
          />
        </div>
        <div className="space-y-1.5">
          <span
            id={scopeIds.labelId}
            className="block text-[13px] font-medium leading-5 text-foreground"
          >
            Works in
          </span>
          <Segmented
            ids={scopeIds}
            value={scope}
            onChange={setPickedScope}
            options={BINDING_SCOPES.map((value) => ({ value, label: SCOPE_LABELS[value] }))}
          />
        </div>
      </div>

      <p id={instructionsId} className="text-[13px] leading-5 text-muted-foreground text-pretty">
        Press the keys for {title}, then Enter to save. Escape cancels. Browser keys such as{" "}
        <span className="whitespace-nowrap">{chordLabel("mod+w", platform)}</span> cannot be
        recorded.
      </p>

      <div id={statusId} role="status" className="space-y-1.5">
        {chord && <span className="sr-only">Recorded {chordSpeech(chord, platform)}.</span>}
        {prompt && <p className="text-[13px] leading-5 text-foreground">Press a shortcut first.</p>}
        {messages.map((message) => (
          <p
            key={message.text}
            className="flex items-start gap-2 text-[13px] leading-5 text-foreground"
          >
            {message.tone === "warning" ? (
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-warning" aria-hidden />
            ) : null}
            <span className="text-pretty">{message.text}</span>
          </p>
        ))}
      </div>

      {error && (
        <div role="alert" className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <p className="flex min-w-0 flex-1 items-start gap-2 text-[13px] leading-5 text-destructive">
            <CircleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            <span className="text-pretty">{error.text}</span>
          </p>
          {error.action && (
            <Button
              variant="outline"
              size="sm"
              className="pointer-coarse:h-11"
              onClick={error.action.run}
            >
              {error.action.label}
            </Button>
          )}
        </div>
      )}

      <div className="flex gap-2">
        <Button size="sm" className="pointer-coarse:h-11" disabled={saving} onClick={submit}>
          {saving ? "Saving…" : "Save"}
        </Button>
        <Button variant="ghost" size="sm" className="pointer-coarse:h-11" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
