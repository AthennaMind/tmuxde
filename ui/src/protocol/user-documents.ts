import { z } from "zod";

/**
 * User documents on the hub, served by GET and PUT /user/{name}. The hub
 * stores the text as sent and validates it with the same rules as these
 * schemas, in internal/hub/settings. Both hold overrides only.
 */
export const USER_DOCUMENT_NAMES = ["settings", "keybindings"] as const;
export const UserDocumentName = z.enum(USER_DOCUMENT_NAMES);
export type UserDocumentName = z.infer<typeof UserDocumentName>;

/** Text of a document the hub has no file for. */
export const USER_DOCUMENT_EMPTY: Record<UserDocumentName, string> = {
  settings: "{}",
  keybindings: "[]",
};

/** Largest body PUT accepts, in bytes. Larger is 413. */
export const USER_DOCUMENT_MAX_BYTES = 256 * 1024;

/** Most keys in settings and most entries in keybindings. */
export const USER_DOCUMENT_MAX_ENTRIES = 512;

/** Path of a document on the hub. */
export const userDocumentPath = (name: UserDocumentName) => `/user/${name}`;

/** Two or more dotted camelCase parts, such as `terminal.fontSize`. */
export const SETTINGS_KEY_PATTERN = /^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/;

/** A command id. A leading `-` removes the default binding of a chord. */
export const COMMAND_ID_PATTERN = /^-?[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/;

/** Modifiers a chord may name, each at most once, before its key name. */
export const KEYBINDING_MODIFIERS = [
  "ctrl",
  "shift",
  "alt",
  "cmd",
  "meta",
  "super",
  "win",
  "mod",
] as const;

/** Key names a chord may end with. */
export const KEYBINDING_KEY_NAMES: readonly string[] = [
  ..."abcdefghijklmnopqrstuvwxyz",
  ..."0123456789",
  ...Array.from({ length: 12 }, (_, i) => `f${i + 1}`),
  "enter",
  "escape",
  "space",
  "tab",
  "backspace",
  "delete",
  "up",
  "down",
  "left",
  "right",
  "home",
  "end",
  "pageup",
  "pagedown",
  "-",
  "=",
  "[",
  "]",
  "`",
  "/",
  "\\",
  ",",
  ".",
  ";",
  "'",
];

export const KEYBINDING_CHORD_MAX_LENGTH = 64;

const modifierSet: ReadonlySet<string> = new Set(KEYBINDING_MODIFIERS);
const keyNameSet: ReadonlySet<string> = new Set(KEYBINDING_KEY_NAMES);

/**
 * Chord grammar shared with the hub: lower case tokens joined by `+`, no
 * spaces. Every token but the last is a modifier, each at most once. The
 * last is a key name.
 */
export function isKeybindingChord(text: string): boolean {
  if (text.length === 0 || text.length > KEYBINDING_CHORD_MAX_LENGTH) return false;
  const tokens = text.split("+");
  const keyName = tokens.pop() ?? "";
  const seen = new Set<string>();
  for (const token of tokens) {
    if (!modifierSet.has(token) || seen.has(token)) return false;
    seen.add(token);
  }
  return keyNameSet.has(keyName);
}

export const KeybindingChord = z
  .string()
  .min(1)
  .max(KEYBINDING_CHORD_MAX_LENGTH)
  .refine(isKeybindingChord, { message: "Invalid chord" });

export const KeybindingScope = z.enum(["global", "app", "terminal"]);
export type KeybindingScope = z.infer<typeof KeybindingScope>;

/** Flat dotted keys with any JSON values. Unknown keys are kept. */
export const UserSettingsDocument = z
  .record(z.string().regex(SETTINGS_KEY_PATTERN), z.unknown())
  .refine((doc) => Object.keys(doc).length <= USER_DOCUMENT_MAX_ENTRIES, {
    message: `At most ${USER_DOCUMENT_MAX_ENTRIES} keys`,
  });
export type UserSettingsDocument = z.infer<typeof UserSettingsDocument>;

/** One binding. `mac` replaces `key` on Mac. One of them is required. */
export const KeybindingEntry = z
  .object({
    key: KeybindingChord.optional(),
    mac: KeybindingChord.optional(),
    command: z.string().regex(COMMAND_ID_PATTERN),
    scope: KeybindingScope.optional(),
    args: z.unknown().optional(),
  })
  .strict()
  .refine((entry) => entry.key !== undefined || entry.mac !== undefined, {
    message: "Needs key or mac",
    path: ["key"],
  });
export type KeybindingEntry = z.infer<typeof KeybindingEntry>;

/** Binding entries after the defaults. Later entries win. */
export const KeybindingsDocument = z.array(KeybindingEntry).max(USER_DOCUMENT_MAX_ENTRIES);
export type KeybindingsDocument = z.infer<typeof KeybindingsDocument>;
