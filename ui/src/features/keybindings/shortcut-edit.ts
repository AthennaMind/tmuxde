import { USER_DOCUMENT_MAX_ENTRIES } from "@/protocol";
import {
  chordFromEvent,
  chordKey,
  hasCommandModifier,
  parseChord,
  type Chord,
  type ChordEvent,
} from "./chord";
import type { CommandId } from "./command-ids";
import { DEFAULT_KEYBINDINGS } from "./default-keybindings";
import { parseKeybindingsDocument } from "./keybindings-store";
import { resolveKeymap, type BindingScope, type Keymap, type ResolvedBinding } from "./keymap";
import type { Platform } from "./platform";

/**
 * What the shortcut recorder reads and writes.
 *
 * Pure: document text in, document text out. The document holds overrides
 * only, so changing a default writes a removal entry for it and a new entry
 * after it. Removing a default writes the removal entry alone. An entry the
 * recorder wrote earlier is replaced instead, so repeated edits do not pile
 * up. Entries written by hand stay as they are.
 */

export const SCOPE_LABELS: Record<BindingScope, string> = {
  global: "Global",
  app: "Outside terminal",
  terminal: "Terminal",
};

/** Field a new entry fills on this platform. `key` also applies on Mac without `mac`. */
export function chordField(platform: Platform): "mac" | "key" {
  return platform === "mac" ? "mac" : "key";
}

/** The binding hints show, and the one Change replaces. Same pick as `shortcutLabel`. */
export function primaryBinding(keymap: Keymap, command: CommandId): ResolvedBinding | undefined {
  const bindings = keymap.bindingsFor(command);
  return bindings.find((binding) => binding.scope === "global") ?? bindings[0];
}

const RESERVED_KEYS = new Set(["w", "t", "n", "q"]);

/**
 * Close tab, new tab, new window and quit, with or without Shift. Outside an
 * installed app the browser acts on these before the page sees them.
 */
export function isBrowserReserved(chord: Chord, platform: Platform): boolean {
  const mod = platform === "mac" ? chord.cmd && !chord.ctrl : chord.ctrl && !chord.cmd;
  return mod && !chord.alt && RESERVED_KEYS.has(chord.key);
}

function overlaps(a: BindingScope, b: BindingScope): boolean {
  return a === "global" || b === "global" || a === b;
}

/** Other commands the chord already runs where `scope` applies. */
export function shortcutConflicts(
  keymap: Keymap,
  chord: Chord,
  scope: BindingScope,
  command: CommandId,
): CommandId[] {
  const found = new Set<CommandId>();
  for (const binding of keymap.lookup.get(chordKey(chord)) ?? []) {
    if (binding.command !== command && overlaps(binding.scope, scope)) found.add(binding.command);
  }
  return [...found];
}

/**
 * Scope a new chord starts with. A chord without ctrl, alt or cmd is typing
 * in the terminal, so it starts outside it. Otherwise it keeps the scope of
 * the binding it replaces.
 */
export function defaultScope(
  chord: Chord,
  replacing?: Pick<ResolvedBinding, "scope">,
): BindingScope {
  if (!hasCommandModifier(chord)) return "app";
  return replacing?.scope ?? "global";
}

/** The chord fires in the terminal without a command modifier, so the shell loses the key. */
export function takesKeyFromShell(chord: Chord, scope: BindingScope): boolean {
  return !hasCommandModifier(chord) && scope !== "app";
}

/** What a key press in the recorder means. */
export type RecorderKey =
  | { kind: "chord"; chord: Chord }
  | { kind: "save" }
  | { kind: "cancel" }
  /** Let the browser have it: Tab moves focus, an input method composes. */
  | { kind: "pass" }
  /** Swallow it: a bare modifier or a held key. */
  | { kind: "ignore" };

export interface RecorderEvent extends ChordEvent {
  repeat?: boolean;
  isComposing?: boolean;
}

/**
 * Plain Tab and Shift+Tab keep moving focus, so the recorder is no keyboard
 * trap. Plain Escape cancels. Plain Enter saves once a chord is recorded.
 * Every other key is the chord.
 */
export function recorderKey(event: RecorderEvent, recorded: boolean): RecorderKey {
  if (event.isComposing) return { kind: "pass" };
  const plain = !event.ctrlKey && !event.altKey && !event.metaKey;
  if (plain && event.key === "Tab") return { kind: "pass" };
  if (plain && !event.shiftKey && (event.key === "Escape" || event.key === "Esc")) {
    return { kind: "cancel" };
  }
  if (plain && !event.shiftKey && event.key === "Enter" && recorded) return { kind: "save" };
  if (event.repeat) return { kind: "ignore" };
  const chord = chordFromEvent(event);
  return chord ? { kind: "chord", chord } : { kind: "ignore" };
}

export type DocumentEdit = { ok: true; text: string } | { ok: false; error: string };

export const BROKEN_DOCUMENT = "The keybindings file has errors. Fix it in the editor first.";
const FULL_DOCUMENT = `The keybindings file holds ${USER_DOCUMENT_MAX_ENTRIES} entries. Remove some in the editor first.`;

function readEntries(text: string): unknown[] | null {
  if (!text.trim()) return [];
  try {
    const data: unknown = JSON.parse(text);
    return Array.isArray(data) ? data : null;
  } catch {
    return null;
  }
}

function serialize(entries: readonly unknown[]): string {
  return `${JSON.stringify(entries, null, 2)}\n`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameArgs(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function resolved(entries: readonly unknown[], platform: Platform): Keymap {
  const { entries: parsed } = parseKeybindingsDocument(JSON.stringify(entries));
  return resolveKeymap(DEFAULT_KEYBINDINGS, parsed, platform);
}

/** The command runs on the chord. With `scope`, only in that scope and with those args. */
function bound(
  keymap: Keymap,
  key: string,
  command: CommandId,
  scope?: BindingScope,
  args?: unknown,
): boolean {
  return (keymap.lookup.get(key) ?? []).some(
    (binding) =>
      binding.command === command &&
      (scope === undefined || (binding.scope === scope && sameArgs(binding.args, args))),
  );
}

const ENTRY_FIELDS = new Set(["key", "mac", "command", "scope", "args"]);

/**
 * Last entry with `command` whose only chord is `key` in this platform's
 * field. Only such an entry can go without changing other platforms.
 */
function ownEntryIndex(
  entries: readonly unknown[],
  command: string,
  key: string,
  platform: Platform,
  matches: (entry: Record<string, unknown>) => boolean,
): number {
  const field = chordField(platform);
  const other = field === "mac" ? "key" : "mac";
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (!isObject(entry) || entry.command !== command || entry[other] !== undefined) continue;
    const text = entry[field];
    if (typeof text !== "string") continue;
    if (Object.keys(entry).some((name) => !ENTRY_FIELDS.has(name)) || !matches(entry)) continue;
    const parsed = parseChord(text, platform);
    if (parsed.ok && chordKey(parsed.chord) === key) return i;
  }
  return -1;
}

/** A binding as an edit names it: chord, scope and args. */
type BindingRef = Pick<ResolvedBinding, "chordKey" | "scope" | "args">;

/**
 * Take a binding off a command, in place on a copy of the entries.
 *
 * Its own entry goes when the recorder wrote it. A removal entry follows
 * when the chord still runs the command, from a default or a hand written
 * entry.
 */
function dropBinding(
  entries: unknown[],
  command: CommandId,
  binding: BindingRef,
  platform: Platform,
): void {
  const own = ownEntryIndex(
    entries,
    command,
    binding.chordKey,
    platform,
    (entry) => (entry.scope ?? "global") === binding.scope && sameArgs(entry.args, binding.args),
  );
  if (own >= 0) entries.splice(own, 1);
  if (bound(resolved(entries, platform), binding.chordKey, command)) {
    entries.push({ [chordField(platform)]: binding.chordKey, command: `-${command}` });
  }
}

export interface ShortcutChange {
  command: CommandId;
  chord: Chord;
  scope: BindingScope;
  /** The binding the new chord takes the place of. Absent when adding one. */
  replacing?: BindingRef;
}

/**
 * Write a new chord for a command.
 *
 * The replaced binding goes first: its own entry when the recorder wrote it,
 * otherwise a removal entry. Then a removal of the new chord that the
 * recorder wrote earlier goes, which brings a default back. A new entry is
 * added only when the chord does not already run the command in that scope.
 */
export function applyShortcutChange(
  text: string,
  change: ShortcutChange,
  platform: Platform,
): DocumentEdit {
  const raw = readEntries(text);
  if (!raw) return { ok: false, error: BROKEN_DOCUMENT };
  const entries = [...raw];
  const field = chordField(platform);
  const { command, replacing, scope } = change;
  const key = chordKey(change.chord);
  const args = replacing?.args;

  if (replacing) dropBinding(entries, command, replacing, platform);

  const removal = ownEntryIndex(
    entries,
    `-${command}`,
    key,
    platform,
    (entry) => entry.scope === undefined && entry.args === undefined,
  );
  if (removal >= 0) entries.splice(removal, 1);

  if (!bound(resolved(entries, platform), key, command, scope, args)) {
    entries.push({ [field]: key, command, scope, ...(args !== undefined ? { args } : {}) });
  }
  if (entries.length > USER_DOCUMENT_MAX_ENTRIES) return { ok: false, error: FULL_DOCUMENT };
  return { ok: true, text: serialize(entries) };
}

export interface ShortcutRemoval {
  command: CommandId;
  /** The binding to take off. The settings row passes `primaryBinding`. */
  binding: BindingRef;
}

/**
 * Take one shortcut off a command without a new one in its place.
 *
 * Same first step as a change: the entry the recorder wrote goes, and a
 * removal entry follows when a default still binds the chord. Other
 * shortcuts of the command stay. Reset brings a removed default back.
 */
export function removeShortcut(
  text: string,
  removal: ShortcutRemoval,
  platform: Platform,
): DocumentEdit {
  const raw = readEntries(text);
  if (!raw) return { ok: false, error: BROKEN_DOCUMENT };
  const entries = [...raw];
  dropBinding(entries, removal.command, removal.binding, platform);
  if (entries.length > USER_DOCUMENT_MAX_ENTRIES) return { ok: false, error: FULL_DOCUMENT };
  return { ok: true, text: serialize(entries) };
}

/**
 * Drop every entry for the command, on every platform, so its defaults
 * apply again. Entries for other commands stay as written.
 */
export function resetCommandEntries(text: string, command: CommandId): DocumentEdit {
  const raw = readEntries(text);
  if (!raw) return { ok: false, error: BROKEN_DOCUMENT };
  const entries = raw.filter(
    (entry) => !(isObject(entry) && (entry.command === command || entry.command === `-${command}`)),
  );
  return { ok: true, text: serialize(entries) };
}

/** Command ids the document has entries for, without the leading `-`. */
export function changedCommands(text: string): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const entry of readEntries(text) ?? []) {
    if (isObject(entry) && typeof entry.command === "string") {
      ids.add(entry.command.replace(/^-/, ""));
    }
  }
  return ids;
}

/** Entries in the document, or null when it is not a JSON array. */
export function entryCount(text: string): number | null {
  return readEntries(text)?.length ?? null;
}
