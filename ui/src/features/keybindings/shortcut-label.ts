import { formatChord, parseChord } from "./chord";
import type { CommandId } from "./command-ids";
import { useKeybindingsStore } from "./keybindings-store";
import type { Keymap } from "./keymap";
import { currentPlatform, type Platform } from "./platform";

/**
 * The hint for a command, such as `⌘K` on a Mac or `Ctrl K` elsewhere.
 *
 * A global binding wins, since it works everywhere. Otherwise the first one.
 * Undefined when the command has no binding. Components pass the keymap they
 * select from the store, so a change re-renders them.
 */
export function shortcutLabel(
  commandId: CommandId,
  keymap: Keymap = useKeybindingsStore.getState().keymap,
): string | undefined {
  const bindings = keymap.bindingsFor(commandId);
  const binding = bindings.find((entry) => entry.scope === "global") ?? bindings[0];
  return binding ? formatChord(binding.chord, keymap.platform) : undefined;
}

/** A fixed key that is no binding, written in chord grammar, such as `mod+enter`. */
export function chordLabel(text: string, platform: Platform = currentPlatform()): string {
  const parsed = parseChord(text, platform);
  return parsed.ok ? formatChord(parsed.chord, platform) : text;
}

/** A control label with its hint, such as `Hide sidebar (Ctrl B)`. Only the label without one. */
export function shortcutTitle(
  label: string,
  commandId: CommandId,
  keymap: Keymap = useKeybindingsStore.getState().keymap,
): string {
  const hint = shortcutLabel(commandId, keymap);
  return hint ? `${label} (${hint})` : label;
}

/**
 * `shortcutTitle` for a control. Reads the keymap from the store, so a rebind
 * or a synced change re-renders the control.
 */
export function useShortcutTitle(label: string, commandId: CommandId): string {
  const keymap = useKeybindingsStore((s) => s.keymap);
  return shortcutTitle(label, commandId, keymap);
}
