import { create } from "zustand";
import { KeybindingsDocument } from "@/protocol";
import { MAX_CHORD_LENGTH, parseChord } from "./chord";
import { isCommandId } from "./command-ids";
import { DEFAULT_KEYBINDINGS } from "./default-keybindings";
import {
  BINDING_SCOPES,
  resolveKeymap,
  type BindingScope,
  type KeybindingEntry,
  type Keymap,
} from "./keymap";
import { currentPlatform, type Platform } from "./platform";

/**
 * Keybindings as the app uses them: user entries, their issues and the
 * resolved keymap for this platform.
 *
 * The settings sync hands each keybindings document text to
 * `applyKeybindingsText`. Until the first one arrives, user entries are empty
 * and only the defaults apply.
 */

/** A problem in the keybindings document. `index` is null for the document itself. */
export interface KeybindingIssue {
  index: number | null;
  /** Field the issue is about, such as `key` or `command`. */
  field?: string;
  message: string;
  /** Errors drop the entry. Warnings keep it. */
  severity: "error" | "warning";
}

export interface ParsedKeybindings {
  entries: KeybindingEntry[];
  issues: KeybindingIssue[];
}

/** Same limits the server applies. */
const MAX_ENTRIES = 512;
const COMMAND_PATTERN = /^-?[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/;
const ENTRY_FIELDS = new Set(["key", "mac", "command", "scope", "args"]);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isScope(value: unknown): value is BindingScope {
  return (BINDING_SCOPES as readonly unknown[]).includes(value);
}

function checkChord(value: unknown, field: "key" | "mac"): string | null {
  if (typeof value !== "string") return `${field} must be a string`;
  if (value.length > MAX_CHORD_LENGTH)
    return `${field} is longer than ${MAX_CHORD_LENGTH} characters`;
  // Grammar only. `mod` resolves when the keymap is built.
  const parsed = parseChord(value, field === "mac" ? "mac" : "other");
  return parsed.ok ? null : parsed.error;
}

/**
 * Read the keybindings document text.
 *
 * Pure. Applies the hub's rules for fields, chords, command ids and scope.
 * `args` may be any JSON, as on the hub. Each command checks the shape it
 * reads. A bad entry is dropped with an error. An unknown command is kept
 * with a warning, since a newer version may know it.
 */
export function parseKeybindingsDocument(text: string): ParsedKeybindings {
  if (!text.trim()) return { entries: [], issues: [] };
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    const reason = error instanceof Error ? error.message : "parse failed";
    return {
      entries: [],
      issues: [{ index: null, message: `Not valid JSON: ${reason}`, severity: "error" }],
    };
  }
  if (!Array.isArray(data)) {
    return {
      entries: [],
      issues: [{ index: null, message: "Keybindings must be a JSON array", severity: "error" }],
    };
  }

  const entries: KeybindingEntry[] = [];
  const issues: KeybindingIssue[] = [];
  if (data.length > MAX_ENTRIES) {
    issues.push({
      index: null,
      message: `More than ${MAX_ENTRIES} entries. The rest are ignored`,
      severity: "error",
    });
  }

  data.slice(0, MAX_ENTRIES).forEach((raw: unknown, index) => {
    const error = (message: string, field?: string) =>
      issues.push({ index, ...(field ? { field } : {}), message, severity: "error" });
    if (!isObject(raw)) {
      error("Entry must be an object");
      return;
    }
    const extra = Object.keys(raw).filter((name) => !ENTRY_FIELDS.has(name));
    if (extra.length) {
      error(`Unknown field ${extra.join(", ")}`, extra[0]);
      return;
    }
    const { key, mac, command, scope, args } = raw;
    if (key === undefined && mac === undefined) {
      error("Entry needs key or mac", "key");
      return;
    }
    for (const field of ["key", "mac"] as const) {
      const value = raw[field];
      if (value === undefined) continue;
      const problem = checkChord(value, field);
      if (problem) {
        error(problem, field);
        return;
      }
    }
    if (typeof command !== "string" || !COMMAND_PATTERN.test(command)) {
      error("command must be a command id such as sidebar.toggle", "command");
      return;
    }
    if (scope !== undefined && !isScope(scope)) {
      error(`scope must be one of ${BINDING_SCOPES.join(", ")}`, "scope");
      return;
    }
    const id = command.startsWith("-") ? command.slice(1) : command;
    if (!isCommandId(id)) {
      issues.push({
        index,
        field: "command",
        message: `Unknown command ${id}`,
        severity: "warning",
      });
    }
    entries.push({
      ...(typeof key === "string" ? { key } : {}),
      ...(typeof mac === "string" ? { mac } : {}),
      command,
      ...(scope !== undefined ? { scope } : {}),
      ...(args !== undefined ? { args } : {}),
    });
  });
  return { entries, issues };
}

/** Parsed keybindings text, and whether it held a JSON array at all. */
export interface ReadKeybindings extends ParsedKeybindings {
  /** False when the text is not a JSON array. Current entries then stay. */
  valid: boolean;
}

/**
 * Read keybindings text in two steps.
 *
 * The protocol schema checks the shape the hub accepts on PUT. Then
 * `parseKeybindingsDocument` applies the app rules and drops bad entries.
 * Both find most problems, so a schema issue is added only for an entry the
 * app rules found no error in. A file edited in a shell can fail the schema
 * and still yield its good entries.
 */
export function readKeybindingsText(text: string): ReadKeybindings {
  const parsed = parseKeybindingsDocument(text);
  if (!text.trim()) return { ...parsed, valid: true };
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { ...parsed, valid: false };
  }
  if (!Array.isArray(data)) return { ...parsed, valid: false };
  const shape = KeybindingsDocument.safeParse(data);
  if (shape.success) return { ...parsed, valid: true };

  const flagged = new Set(
    parsed.issues.filter((issue) => issue.severity === "error").map((issue) => issue.index),
  );
  const issues = [...parsed.issues];
  for (const problem of shape.error.issues) {
    const [first, second] = problem.path;
    const index = typeof first === "number" ? first : null;
    if (flagged.has(index)) continue;
    flagged.add(index);
    issues.push({
      index,
      ...(typeof second === "string" ? { field: second } : {}),
      message: problem.message,
      severity: "error",
    });
  }
  return { entries: parsed.entries, issues, valid: true };
}

/**
 * Apply keybindings text from the user documents store and return its
 * issues. Text that is not a JSON array keeps the current entries, as broken
 * settings text keeps the current values.
 */
export function applyKeybindingsText(text: string): readonly KeybindingIssue[] {
  const { entries, issues, valid } = readKeybindingsText(text);
  const store = useKeybindingsStore.getState();
  store.setUserEntries(valid ? entries : store.userEntries, issues);
  return issues;
}

interface KeybindingsState {
  platform: Platform;
  /** Entries from the user document, in file order. */
  userEntries: readonly KeybindingEntry[];
  /** Issues found while reading the user document. */
  issues: readonly KeybindingIssue[];
  /** Defaults plus user entries, resolved for `platform`. */
  keymap: Keymap;
  /** Replace the user entries and resolve the keymap again. */
  setUserEntries: (
    entries: readonly KeybindingEntry[],
    issues?: readonly KeybindingIssue[],
  ) => void;
}

const platform = currentPlatform();

export const useKeybindingsStore = create<KeybindingsState>((set, get) => ({
  platform,
  userEntries: [],
  issues: [],
  keymap: resolveKeymap(DEFAULT_KEYBINDINGS, [], platform),
  setUserEntries: (entries, issues = []) =>
    set({
      userEntries: entries,
      issues,
      keymap: resolveKeymap(DEFAULT_KEYBINDINGS, entries, get().platform),
    }),
}));
