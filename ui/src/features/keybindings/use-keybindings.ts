import { useEffect } from "react";
import { chordFromEvent, chordKey, hasCommandModifier, type ChordEvent } from "./chord";
import { getCommand, type Command } from "./commands";
import { useKeybindingsStore } from "./keybindings-store";
import type { Keymap, ResolvedBinding } from "./keymap";
import { bindingsPaused } from "./recording-pause";
import { focusStateOf, type FocusState } from "./scope";

export interface BindingEvent extends ChordEvent {
  repeat: boolean;
  isComposing?: boolean;
}

type CommandLike = Pick<Command, "id" | "toggle" | "enabled">;

export interface BindingDecision<C extends CommandLike = Command> {
  command: C;
  binding: ResolvedBinding;
  /** Key repeat of a toggle command. Swallow the key, do not run it again. */
  repeat: boolean;
}

/**
 * Which binding a key press runs, if any. Pure, so tests need no DOM.
 *
 * Candidates are tried most recent first. A candidate is skipped when its
 * scope does not match focus or its command is disabled. A chord without
 * ctrl, alt or cmd never fires while text entry has focus. Null means the
 * key is not ours and everything behaves as without bindings.
 */
export function decideBinding<C extends CommandLike>(
  event: BindingEvent,
  keymap: Keymap,
  focus: FocusState,
  lookup: (id: string) => C | undefined,
): BindingDecision<C> | null {
  if (event.isComposing) return null;
  const chord = chordFromEvent(event);
  if (!chord) return null;
  const candidates = keymap.lookup.get(chordKey(chord));
  if (!candidates) return null;
  if (focus.textEntry && !hasCommandModifier(chord)) return null;
  for (const binding of candidates) {
    if (binding.scope === "app" && focus.terminal) continue;
    if (binding.scope === "terminal" && !focus.terminal) continue;
    const command = lookup(binding.command);
    if (!command || (command.enabled && !command.enabled())) continue;
    return { command, binding, repeat: event.repeat && command.toggle === true };
  }
  return null;
}

/**
 * The window keydown handler. Exported for tests. While the shortcut
 * recorder holds a pause, every key goes through untouched.
 */
export function handleBindingKey(event: KeyboardEvent): void {
  if (bindingsPaused()) return;
  const decision = decideBinding(
    event,
    useKeybindingsStore.getState().keymap,
    focusStateOf(document.activeElement),
    getCommand,
  );
  if (!decision) return;
  if (!decision.repeat) {
    const { args } = decision.binding;
    const handled = decision.command.run(args !== undefined ? { args, event } : { event });
    if (handled === false) return;
  }
  // Ours now. xterm and Monaco never see it, so tmux never gets it.
  event.preventDefault();
  event.stopPropagation();
}

/**
 * The app's one keydown listener for bindings. Capture phase on window, so
 * it runs before xterm's textarea listener and before Monaco. Mount once.
 */
export function useKeybindings(): void {
  useEffect(() => {
    window.addEventListener("keydown", handleBindingKey, true);
    return () => window.removeEventListener("keydown", handleBindingKey, true);
  }, []);
}
