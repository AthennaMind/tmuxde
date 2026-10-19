import { chordKey, parseChord, type Chord } from "./chord";
import { isCommandId, type CommandId } from "./command-ids";
import type { Platform } from "./platform";

/**
 * Where a binding fires. `global` everywhere, `app` only while the terminal
 * is not focused, `terminal` only while it is.
 */
export const BINDING_SCOPES = ["global", "app", "terminal"] as const;

export type BindingScope = (typeof BINDING_SCOPES)[number];

/** One entry of the keybindings document, or of the defaults. */
export interface KeybindingEntry {
  /** Chord on every platform without a `mac` value. */
  key?: string;
  /** Chord on Mac instead of `key`. An entry with only `mac` is Mac only. */
  mac?: string;
  /** Command id. A leading `-` removes earlier bindings of the chord and command. */
  command: string;
  scope?: BindingScope;
  /** Any JSON. Each command checks the shape it reads. */
  args?: unknown;
}

/**
 * A built in binding. `platform` limits it to one platform, which a user
 * entry cannot say: an entry with only `key` applies on Mac too.
 */
export interface DefaultKeybindingEntry extends KeybindingEntry {
  platform?: Platform;
}

export type BindingSource = "default" | "user";

export interface ResolvedBinding {
  chord: Chord;
  chordKey: string;
  command: CommandId;
  scope: BindingScope;
  args?: unknown;
  source: BindingSource;
  /** Index of the entry in its source list. */
  index: number;
}

/** Two or more bindings on one chord whose scopes overlap. The first wins. */
export interface KeymapConflict {
  chordKey: string;
  bindings: readonly ResolvedBinding[];
}

/** An entry the keymap skipped. Resolution goes on without it. */
export interface KeymapIssue {
  source: BindingSource;
  index: number;
  message: string;
}

export interface Keymap {
  platform: Platform;
  /** Candidates per chord key, most recent entry first. */
  lookup: ReadonlyMap<string, readonly ResolvedBinding[]>;
  /** Bindings of a command in entry order, without those a later binding hides. */
  bindingsFor(commandId: string): readonly ResolvedBinding[];
  conflicts: readonly KeymapConflict[];
  /** Command ids that no command answers to, from newer versions or typos. */
  unknownCommands: readonly string[];
  issues: readonly KeymapIssue[];
}

/** The chord text an entry uses on this platform, if any. */
export function entryChordText(entry: KeybindingEntry, platform: Platform): string | undefined {
  return platform === "mac" ? (entry.mac ?? entry.key) : entry.key;
}

function overlaps(a: BindingScope, b: BindingScope): boolean {
  return a === "global" || b === "global" || a === b;
}

function sameAction(a: ResolvedBinding, b: ResolvedBinding): boolean {
  return a.command === b.command && JSON.stringify(a.args) === JSON.stringify(b.args);
}

/**
 * Defaults plus user entries, for one platform.
 *
 * Entries apply in order, defaults first. Later entries win a chord. A
 * removal drops every earlier binding with the same chord and command. An
 * entry without a chord for this platform is skipped, and so is a default
 * for another platform. Unknown commands and bad chords become issues and
 * never stop the rest.
 */
export function resolveKeymap(
  defaults: readonly DefaultKeybindingEntry[],
  userEntries: readonly KeybindingEntry[],
  platform: Platform,
): Keymap {
  const active: ResolvedBinding[] = [];
  const issues: KeymapIssue[] = [];
  const unknown = new Set<string>();

  const apply = (entries: readonly DefaultKeybindingEntry[], source: BindingSource) => {
    entries.forEach((entry, index) => {
      if (source === "default" && entry.platform && entry.platform !== platform) return;
      const removal = entry.command.startsWith("-");
      const id = removal ? entry.command.slice(1) : entry.command;
      if (!isCommandId(id)) {
        unknown.add(id);
        issues.push({ source, index, message: `Unknown command ${id}` });
        return;
      }
      const text = entryChordText(entry, platform);
      if (text === undefined) return;
      const parsed = parseChord(text, platform);
      if (!parsed.ok) {
        issues.push({ source, index, message: `${text}: ${parsed.error}` });
        return;
      }
      const key = chordKey(parsed.chord);
      if (removal) {
        for (let i = active.length - 1; i >= 0; i--) {
          const binding = active[i];
          if (binding && binding.chordKey === key && binding.command === id) active.splice(i, 1);
        }
        return;
      }
      active.push({
        chord: parsed.chord,
        chordKey: key,
        command: id,
        scope: entry.scope ?? "global",
        ...(entry.args !== undefined ? { args: entry.args } : {}),
        source,
        index,
      });
    });
  };
  apply(defaults, "default");
  apply(userEntries, "user");

  const lookup = new Map<string, ResolvedBinding[]>();
  for (let i = active.length - 1; i >= 0; i--) {
    const binding = active[i];
    if (!binding) continue;
    const list = lookup.get(binding.chordKey);
    if (list) list.push(binding);
    else lookup.set(binding.chordKey, [binding]);
  }

  const shadowed = new Set<ResolvedBinding>();
  const conflicts: KeymapConflict[] = [];
  for (const [key, list] of lookup) {
    let conflict = false;
    list.forEach((binding, position) => {
      for (const later of list.slice(0, position)) {
        if (later.scope === "global" || later.scope === binding.scope) shadowed.add(binding);
        if (overlaps(later.scope, binding.scope) && !sameAction(later, binding)) conflict = true;
      }
    });
    if (conflict) conflicts.push({ chordKey: key, bindings: list });
  }

  const byCommand = new Map<string, ResolvedBinding[]>();
  for (const binding of active) {
    if (shadowed.has(binding)) continue;
    const list = byCommand.get(binding.command);
    if (list) list.push(binding);
    else byCommand.set(binding.command, [binding]);
  }

  return {
    platform,
    lookup,
    bindingsFor: (commandId) => byCommand.get(commandId) ?? [],
    conflicts,
    unknownCommands: [...unknown],
    issues,
  };
}
