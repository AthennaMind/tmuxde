import { z } from "zod";
import { DEFAULT_TERMINAL_THEME, terminalThemes } from "@/features/terminal/terminal-themes";
import { DEFAULT_TERMINAL_FONT } from "@/features/terminal/terminal-font";
import {
  CODE_WEIGHTS,
  CODE_ZOOM_MAX,
  CODE_ZOOM_MIN,
  getDefaultFontSize,
} from "@/features/terminal/terminal-store";
import { defaultToolbarKeys } from "./settings-store";

/**
 * Registry of the synced settings document.
 *
 * The server keeps `settings.json` as flat dotted keys, VS Code style, and
 * only values that differ from the defaults below. Every key carries its Zod
 * value schema, a default, a scope, a section and a label.
 *
 * User scope keys live in the server document and follow the user to every
 * browser. Device scope keys live in this browser only, see
 * `device-settings.ts`. When both hold a value, the device value wins.
 */

export type SettingScope = "user" | "device";

export type SettingSection =
  | "Appearance"
  | "Text"
  | "Terminal"
  | "Sessions"
  | "Files"
  | "Changes"
  | "Touch"
  | "Pinned terminal keys";

interface SettingValue<T> {
  schema: z.ZodType<T, z.ZodTypeDef, unknown>;
}

export interface SettingDefinition<
  T,
  S extends SettingScope = SettingScope,
> extends SettingValue<T> {
  /** A value, or a thunk for defaults that depend on the device. */
  default: NoInfer<T> | (() => NoInfer<T>);
  scope: S;
  section: SettingSection;
  label: string;
  description: string;
}

/** Same rule as the server. Lower camel case parts joined by dots. */
const KEY_PATTERN = /^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/;
const MAX_KEYS = 512;

function booleanValue(): SettingValue<boolean> {
  return { schema: z.boolean() };
}

function integerValue(minimum: number, maximum: number): SettingValue<number> {
  return { schema: z.number().int().min(minimum).max(maximum) };
}

function numberValue(minimum: number, maximum: number): SettingValue<number> {
  return { schema: z.number().min(minimum).max(maximum) };
}

function stringValue(): SettingValue<string> {
  return { schema: z.string() };
}

function oneOf<const T extends readonly (string | number)[]>(values: T): SettingValue<T[number]> {
  const allowed: readonly unknown[] = values;
  return {
    schema: z.custom<T[number]>((value) => allowed.includes(value), {
      message: `Expected one of ${values.map((value) => JSON.stringify(value)).join(", ")}`,
    }),
  };
}

const TOOLBAR_KEY_IDS = defaultToolbarKeys.map((key) => key.id);

/**
 * Visible toolbar key ids, in toolbar order. Unknown and repeated ids drop,
 * so a key removed in a later release cannot linger in the resolved value.
 */
function toolbarKeyIds(): SettingValue<string[]> {
  return {
    schema: z
      .array(z.string())
      .transform((ids) => TOOLBAR_KEY_IDS.filter((id) => ids.includes(id))),
  };
}

const TERMINAL_THEME_NAMES = [DEFAULT_TERMINAL_THEME, ...Object.keys(terminalThemes)];

function setting<T, S extends SettingScope>(
  entry: SettingDefinition<T, S>,
): SettingDefinition<T, S> {
  return entry;
}

function gesture(label: string, description: string) {
  return setting({
    ...booleanValue(),
    default: true,
    scope: "user",
    section: "Touch",
    label,
    description,
  });
}

export const SETTINGS = {
  "appearance.theme": setting({
    ...oneOf(["light", "dark", "system"] as const),
    default: "dark",
    scope: "user",
    section: "Appearance",
    label: "App theme",
    description: "Light, dark, or system to follow the device.",
  }),
  "terminal.theme": setting({
    ...oneOf(TERMINAL_THEME_NAMES),
    default: DEFAULT_TERMINAL_THEME,
    scope: "user",
    section: "Appearance",
    label: "Terminal theme",
    description: `Terminal color scheme. "${DEFAULT_TERMINAL_THEME}" matches the app theme.`,
  }),
  "terminal.fontSize": setting({
    ...integerValue(8, 24),
    default: () => getDefaultFontSize(),
    scope: "device",
    section: "Text",
    label: "Terminal font size",
    description: "Terminal font size in pixels, 8 to 24. Kept per device.",
  }),
  "terminal.fontFamily": setting({
    ...stringValue(),
    default: DEFAULT_TERMINAL_FONT,
    scope: "user",
    section: "Text",
    label: "Terminal font",
    description: "CSS font family list for terminal text.",
  }),
  "terminal.fontWeight": setting({
    ...oneOf(CODE_WEIGHTS),
    default: 600,
    scope: "user",
    section: "Text",
    label: "Terminal font weight",
    description: "Weight of terminal text. Bold output uses 700.",
  }),
  "terminal.cursorStyle": setting({
    ...oneOf(["block", "underline", "bar"] as const),
    default: "block",
    scope: "user",
    section: "Terminal",
    label: "Cursor",
    description: "Shape of the terminal cursor.",
  }),
  "terminal.cursorBlink": setting({
    ...booleanValue(),
    default: true,
    scope: "user",
    section: "Terminal",
    label: "Blink the cursor",
    description: "Blink the terminal cursor.",
  }),
  "terminal.copyOnSelect": setting({
    ...booleanValue(),
    default: true,
    scope: "user",
    section: "Terminal",
    label: "Copy on select",
    description: "Copy selected terminal text to the clipboard.",
  }),
  "terminal.scrollback": setting({
    ...integerValue(100, 100000),
    default: 5000,
    scope: "user",
    section: "Terminal",
    label: "Scrollback lines",
    description: "Lines of terminal history, 100 to 100000.",
  }),
  "terminal.gpuRendering": setting({
    ...booleanValue(),
    default: false,
    scope: "device",
    section: "Terminal",
    label: "GPU rendering",
    description: "Use the WebGL renderer on desktop. Kept per device.",
  }),
  "editor.fontWeight": setting({
    ...oneOf(CODE_WEIGHTS),
    default: 600,
    scope: "user",
    section: "Text",
    label: "File and diff text weight",
    description: "Weight of text in files, diffs and the editor.",
  }),
  "editor.zoom": setting({
    ...numberValue(CODE_ZOOM_MIN, CODE_ZOOM_MAX),
    default: 1,
    scope: "device",
    section: "Text",
    label: "File and diff text size",
    description: `Scale of files, diffs and the editor, ${CODE_ZOOM_MIN} to ${CODE_ZOOM_MAX}. Kept per device.`,
  }),
  "panes.autoZoom": setting({
    ...booleanValue(),
    default: true,
    scope: "user",
    section: "Touch",
    label: "Zoom the active pane",
    description: "Zoom the active pane when a session opens or a pane splits.",
  }),
  "panes.showIndexes": setting({
    ...booleanValue(),
    default: true,
    scope: "user",
    section: "Sessions",
    label: "Show pane indexes",
    description: "Show the tmux pane index in the corner of each pane.",
  }),
  "files.wrapLines": setting({
    ...booleanValue(),
    default: false,
    scope: "user",
    section: "Files",
    label: "Wrap long lines",
    description: "Soft wrap long lines in file and diff previews.",
  }),
  "files.markdownPreview": setting({
    ...booleanValue(),
    default: true,
    scope: "user",
    section: "Files",
    label: "Render Markdown",
    description: "Show Markdown files rendered. Off shows their source.",
  }),
  "changes.filterPatterns": setting({
    ...stringValue(),
    default: "",
    scope: "user",
    section: "Changes",
    label: "Commit file filter",
    description: "File patterns for the commit view, separated by commas.",
  }),
  "changes.filterMode": setting({
    ...oneOf(["hide", "only"] as const),
    default: "hide",
    scope: "user",
    section: "Changes",
    label: "Commit filter mode",
    description: "Hide files that match the patterns, or show only them.",
  }),
  "touch.haptics": setting({
    ...booleanValue(),
    default: true,
    scope: "user",
    section: "Touch",
    label: "Vibrate on key press",
    description: "Vibrate on toolbar key presses.",
  }),
  "touch.gesture.swipeToSwitchSessions": gesture(
    "Swipe to switch sessions",
    "Swipe sideways on the terminal to switch sessions.",
  ),
  "touch.gesture.swipeToSwitchPanes": gesture(
    "Swipe to switch panes",
    "Swipe sideways on the terminal to switch panes.",
  ),
  "touch.gesture.dragToScroll": gesture(
    "Drag to scroll history",
    "Drag one finger up or down to scroll tmux history.",
  ),
  "touch.gesture.pinchToZoom": gesture("Pinch to zoom", "Pinch to change the terminal font size."),
  "touch.gesture.longPressPaneMenu": gesture(
    "Long press a pane for options",
    "Press and hold a pane to open its options.",
  ),
  "touch.toolbarKeys": setting({
    ...toolbarKeyIds(),
    default: () => defaultToolbarKeys.filter((key) => key.visible).map((key) => key.id),
    scope: "user",
    section: "Pinned terminal keys",
    label: "Pinned terminal keys",
    description: "Ids of the keys shown in the terminal key toolbar.",
  }),
};

type Registry = typeof SETTINGS;

export type SettingKey = keyof Registry;

export type Settings = {
  [K in SettingKey]: Registry[K] extends SettingDefinition<infer T> ? T : never;
};

export type DeviceSettingKey = {
  [K in SettingKey]: Registry[K]["scope"] extends "device" ? K : never;
}[SettingKey];

/** Parsed settings document. Keys are dotted, values any JSON. */
export type SettingsDocument = Record<string, unknown>;

/** A change for `updateSettings`. An undefined value deletes the key. */
export type SettingsPatch = Record<string, unknown>;

export interface DocumentIssue {
  severity: "error" | "warning";
  message: string;
  /** Setting key, or entry path for array documents. */
  path?: string;
}

export const SETTINGS_KEYS = Object.keys(SETTINGS) as SettingKey[];

export function isSettingKey(key: string): key is SettingKey {
  return Object.hasOwn(SETTINGS, key);
}

export function isDeviceSettingKey(key: string): key is DeviceSettingKey {
  return isSettingKey(key) && SETTINGS[key].scope === "device";
}

function definition<K extends SettingKey>(key: K): SettingDefinition<Settings[K]> {
  return SETTINGS[key] as unknown as SettingDefinition<Settings[K]>;
}

export function settingDefault<K extends SettingKey>(key: K): Settings[K] {
  const fallback = definition(key).default;
  return typeof fallback === "function" ? (fallback as () => Settings[K])() : fallback;
}

/** Parse one value with the key's schema. Undefined when it does not fit. */
export function parseSettingValue<K extends SettingKey>(
  key: K,
  value: unknown,
): Settings[K] | undefined {
  if (value === undefined) return undefined;
  const result = definition(key).schema.safeParse(value);
  return result.success ? result.data : undefined;
}

/** Value equality for settings. Arrays compare by item, objects by JSON. */
export function sameSettingValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => sameSettingValue(item, b[index]));
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return false;
}

function own(source: Readonly<Record<string, unknown>> | null | undefined, key: string): unknown {
  return source && Object.hasOwn(source, key) ? source[key] : undefined;
}

/**
 * Typed settings from the document and this device's overrides.
 *
 * Device scope keys take the device value first, then the document, then the
 * default. User scope keys take the document, then the default. A value of
 * the wrong type counts as missing.
 */
export function resolveSettings(
  document: Readonly<SettingsDocument> | null | undefined,
  deviceOverrides: Readonly<Record<string, unknown>> = {},
): Settings {
  const resolved: Record<string, unknown> = {};
  for (const key of SETTINGS_KEYS) {
    const sources =
      SETTINGS[key].scope === "device"
        ? [own(deviceOverrides, key), own(document, key)]
        : [own(document, key)];
    let value: unknown;
    for (const source of sources) {
      value = parseSettingValue(key, source);
      if (value !== undefined) break;
    }
    resolved[key] = value === undefined ? settingDefault(key) : value;
  }
  return resolved as Settings;
}

/** The overrides document for user scope keys. Defaults are left out. */
export function diffFromDefaults(settings: Partial<Settings>): SettingsDocument {
  const document: SettingsDocument = {};
  for (const key of SETTINGS_KEYS) {
    if (SETTINGS[key].scope !== "user" || !Object.hasOwn(settings, key)) continue;
    const value = settings[key];
    if (value === undefined || sameSettingValue(value, settingDefault(key))) continue;
    document[key] = value;
  }
  return document;
}

/**
 * Check a parsed settings document.
 *
 * The document comes back whole. Unknown keys are warnings and stay, so a
 * save never drops them. Wrong types are errors, and `resolveSettings`
 * ignores those keys. Anything other than an object yields an empty document.
 */
export function validateSettingsDocument(input: unknown): {
  document: SettingsDocument;
  issues: DocumentIssue[];
} {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return {
      document: {},
      issues: [{ severity: "error", message: "Settings must be a JSON object." }],
    };
  }
  const document = input as SettingsDocument;
  const issues: DocumentIssue[] = [];
  const keys = Object.keys(document);
  if (keys.length > MAX_KEYS) {
    issues.push({ severity: "error", message: `At most ${MAX_KEYS} settings are allowed.` });
  }
  for (const key of keys) {
    if (!KEY_PATTERN.test(key)) {
      issues.push({
        severity: "error",
        path: key,
        message: "Keys are dotted lower camel case, like terminal.fontSize.",
      });
      continue;
    }
    if (!isSettingKey(key)) {
      issues.push({ severity: "warning", path: key, message: "Unknown setting. It is kept." });
      continue;
    }
    const result = definition(key).schema.safeParse(document[key]);
    if (!result.success) {
      const message = result.error.issues[0]?.message ?? "Wrong type";
      issues.push({ severity: "error", path: key, message: `${message}. The default applies.` });
    } else if (SETTINGS[key].scope === "device") {
      issues.push({
        severity: "warning",
        path: key,
        message: "Device setting. A value set on this device wins.",
      });
    }
  }
  return { document, issues };
}

/** Keys in the settings text. Null when it is not a JSON object. */
export function settingsCount(text: string): number | null {
  try {
    const data: unknown = JSON.parse(text);
    if (!data || typeof data !== "object" || Array.isArray(data)) return null;
    return Object.keys(data).length;
  } catch {
    return null;
  }
}

/** Parse and check settings text. Broken JSON yields an empty document. */
export function parseSettingsText(text: string): {
  document: SettingsDocument;
  issues: DocumentIssue[];
  valid: boolean;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const reason = error instanceof Error ? error.message : "parse error";
    return {
      document: {},
      issues: [{ severity: "error", message: `Invalid JSON: ${reason}` }],
      valid: false,
    };
  }
  const { document, issues } = validateSettingsDocument(parsed);
  return {
    document,
    issues,
    valid: !!parsed && typeof parsed === "object" && !Array.isArray(parsed),
  };
}
