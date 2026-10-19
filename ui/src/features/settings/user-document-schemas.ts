import {
  KEYBINDING_CHORD_MAX_LENGTH,
  KEYBINDING_KEY_NAMES,
  KEYBINDING_MODIFIERS,
  USER_DOCUMENT_MAX_ENTRIES,
  USER_DOCUMENT_NAMES,
  type UserDocumentName,
} from "@/protocol";
import { COMMAND_IDS, COMMAND_INFO } from "@/features/keybindings/command-ids";
import { BINDING_SCOPES, type BindingScope } from "@/features/keybindings/keymap";
import { settingsJsonSchema } from "./settings-schema";

/**
 * JSON schemas of the two user documents, for completion and squiggles in
 * the Monaco JSON editor. Settings come from the settings registry, bindings
 * from the command registry, so both follow new keys and commands.
 */

type JsonSchema = Record<string, unknown>;

/** Schema ids. Monaco never fetches them. They only name the schemas. */
export const USER_DOCUMENT_SCHEMA_URIS: Record<UserDocumentName, string> = {
  settings: "tmuxde://schemas/settings.json",
  keybindings: "tmuxde://schemas/keybindings.json",
};

const SCHEMA_URI_PREFIX = "tmuxde://schemas/";

const SCOPE_DESCRIPTIONS: Record<BindingScope, string> = {
  global: "Fires everywhere, in the terminal and the editor too.",
  app: "Fires only while the terminal does not have focus.",
  terminal: "Fires only while the terminal has focus.",
};

const PALETTE_MODES = ["commands", "files", "terminals"];

/** Regex syntax characters. `-` needs no escape outside a class. */
function escapeRegex(text: string): string {
  return text.replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&");
}

/** The chord grammar as one pattern. Repeated modifiers are left to the issue list. */
export function chordPattern(): string {
  const modifiers = KEYBINDING_MODIFIERS.join("|");
  const keys = KEYBINDING_KEY_NAMES.map(escapeRegex).join("|");
  return `^(?:(?:${modifiers})\\+)*(?:${keys})$`;
}

function chordSchema(description: string): JsonSchema {
  return {
    type: "string",
    minLength: 1,
    maxLength: KEYBINDING_CHORD_MAX_LENGTH,
    pattern: chordPattern(),
    patternErrorMessage: "Write one chord in lower case, keys joined by +, such as ctrl+shift+k.",
    description,
  };
}

export function keybindingsJsonSchema(): JsonSchema {
  const titles = COMMAND_IDS.map((id) => COMMAND_INFO[id].title);
  const entry: JsonSchema = {
    type: "object",
    properties: {
      key: chordSchema(
        "Chord such as ctrl+shift+k. mod is Cmd on Mac and Ctrl elsewhere. Applies on Mac too unless mac is set.",
      ),
      mac: chordSchema("Chord used on Mac instead of key. An entry with only mac is Mac only."),
      command: {
        type: "string",
        description:
          "Command to run. A leading - removes earlier bindings of this chord and command.",
        enum: [...COMMAND_IDS, ...COMMAND_IDS.map((id) => `-${id}`)],
        enumDescriptions: [...titles, ...titles.map((title) => `Remove a binding of ${title}`)],
      },
      scope: {
        enum: [...BINDING_SCOPES],
        enumDescriptions: BINDING_SCOPES.map((scope) => SCOPE_DESCRIPTIONS[scope]),
        default: "global",
        description: "Where the binding fires.",
      },
      args: {
        description: "Passed to the command. Any JSON. palette.open reads an object with mode.",
        properties: {
          mode: { enum: PALETTE_MODES, description: "Palette mode. Read by palette.open." },
        },
      },
    },
    required: ["command"],
    additionalProperties: false,
    anyOf: [{ required: ["key"] }, { required: ["mac"] }],
    defaultSnippets: [
      {
        label: "New binding",
        description: "A chord and the command it runs",
        body: { key: "$1", command: "$2" },
      },
    ],
  };
  return {
    type: "array",
    items: entry,
    maxItems: USER_DOCUMENT_MAX_ENTRIES,
    description: "Changes to the default shortcuts. Later entries win.",
  };
}

export function userDocumentJsonSchema(name: UserDocumentName): JsonSchema {
  return name === "settings" ? settingsJsonSchema() : keybindingsJsonSchema();
}

export interface SchemaAssociation {
  uri: string;
  fileMatch: string[];
  schema: JsonSchema;
}

/**
 * Monaco `schemas` entries for the open editors.
 *
 * `models` maps a model path pattern to the document it shows. Each
 * document's schema matches only its own models, so a JSON file opened in
 * the file editor never gets these rules.
 */
export function schemaAssociations(
  models: ReadonlyMap<string, UserDocumentName>,
): SchemaAssociation[] {
  return USER_DOCUMENT_NAMES.flatMap((name) => {
    const fileMatch = [...models].filter(([, shown]) => shown === name).map(([path]) => path);
    if (fileMatch.length === 0) return [];
    return [
      { uri: USER_DOCUMENT_SCHEMA_URIS[name], fileMatch, schema: userDocumentJsonSchema(name) },
    ];
  });
}

/** Entries this module did not add, so they survive a refresh of ours. */
export function foreignSchemas<T extends { uri: string }>(schemas: readonly T[] | undefined): T[] {
  return (schemas ?? []).filter((entry) => !entry.uri.startsWith(SCHEMA_URI_PREFIX));
}

/**
 * Glob for one model. Monaco prefixes patterns with a path wildcard and
 * matches the whole URI, so `inmemory://model/3` matches `model/3` and no
 * other model.
 */
export function modelPattern(uri: string): string {
  return uri.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
}
