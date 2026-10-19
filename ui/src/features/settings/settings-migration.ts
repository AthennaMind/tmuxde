import { migrateTerminalStore } from "@/features/terminal/terminal-store";
import { DEFAULT_TERMINAL_FONT, terminalFontFamily } from "@/features/terminal/terminal-font";
import { mergeToolbarKeys, type ToolbarKey } from "./settings-store";
import {
  SETTINGS_KEYS,
  isDeviceSettingKey,
  parseSettingValue,
  sameSettingValue,
  settingDefault,
  type DeviceSettingKey,
  type SettingKey,
  type Settings,
  type SettingsDocument,
} from "./settings-schema";
import { readDeviceSettings, writeDeviceSetting } from "./device-settings";
import { THEME_CACHE_KEY } from "./theme-setting";

/**
 * One time move from the old per browser stores to the synced document.
 *
 * Before the settings document, `useSettingsStore` and `useTerminalStore`
 * persisted to localStorage `ccremote-settings` and `ccremote-terminal`, and
 * the app theme sat in `theme`. Those blobs are read here, checked with the
 * same schemas as the document, and split by scope.
 *
 * Rule for the caller: run `migrateLegacySettings` only when the server
 * settings document is empty, on its first load. A document with content
 * already holds choices made in some browser, and old local values must not
 * overwrite them. Save the returned overrides, then call
 * `finishLegacyMigration`. When it returns null, call `finishLegacyMigration`
 * right away. When the server document is not empty, call
 * `migrateLegacyDeviceSettings` instead, then `finishLegacyMigration`, so this
 * browser still keeps its own sizes.
 *
 * The `theme` key stays after the move, as the pre paint cache. So
 * `finishLegacyMigration` also sets `tmuxde-settings-migrated`, and from then
 * on the cache no longer counts as an old choice. Without that flag, a later
 * first sync, such as one after a disconnect, would push a cached theme into
 * an empty server document. The flag survives disconnect.
 */

export const LEGACY_SETTINGS_KEY = "ccremote-settings";
export const LEGACY_TERMINAL_KEY = "ccremote-terminal";
export const LEGACY_MIGRATED_KEY = "tmuxde-settings-migrated";

type Values = Partial<Record<SettingKey, unknown>>;

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** The `{ state, version }` blob zustand's persist wrote. */
function readPersisted(key: string): { state: Record<string, unknown>; version: number } | null {
  try {
    const text = storage()?.getItem(key);
    if (!text) return null;
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed) || !isRecord(parsed.state)) return null;
    return {
      state: parsed.state,
      version: typeof parsed.version === "number" ? parsed.version : 0,
    };
  } catch {
    return null;
  }
}

/** The theme cache as an old choice, only until the migration finished once. */
function readTheme(): string | null {
  try {
    const store = storage();
    if (!store || store.getItem(LEGACY_MIGRATED_KEY) !== null) return null;
    return store.getItem(THEME_CACHE_KEY);
  } catch {
    return null;
  }
}

function terminalValues(): Values {
  const blob = readPersisted(LEGACY_TERMINAL_KEY);
  if (!blob) return {};
  const state = migrateTerminalStore(blob.state, blob.version);
  const values: Values = {
    "terminal.theme": state.themeName,
    "terminal.fontSize": state.fontSize,
    "terminal.fontWeight": state.terminalWeight,
    "terminal.cursorStyle": state.cursorStyle,
    "terminal.cursorBlink": state.cursorBlink,
    "terminal.copyOnSelect": state.copyOnSelect,
    "terminal.scrollback": state.scrollback,
    "terminal.gpuRendering": state.gpuRendering,
    "editor.fontWeight": state.codeWeight,
    "editor.zoom": state.codeZoom,
  };
  // Old defaults were saved for everyone and were never a choice. They draw
  // the same as today's default, so they are not an override.
  const family = state.fontFamily;
  if (
    typeof family === "string" &&
    terminalFontFamily(family) !== terminalFontFamily(DEFAULT_TERMINAL_FONT)
  ) {
    values["terminal.fontFamily"] = family;
  }
  return values;
}

function settingsValues(): Values {
  const blob = readPersisted(LEGACY_SETTINGS_KEY);
  if (!blob) return {};
  const { state } = blob;
  const values: Values = {
    "panes.autoZoom": state.autoZoom,
    "panes.showIndexes": state.showPaneIndexes,
    "files.wrapLines": state.wrapLines,
    "files.markdownPreview": state.markdownPreview,
    "changes.filterPatterns": state.commitFilterPatterns,
    "changes.filterMode": state.commitFilterMode,
    "touch.haptics": state.hapticEnabled,
  };
  if (isRecord(state.gestures)) {
    const gestures = state.gestures;
    values["touch.gesture.swipeToSwitchSessions"] = gestures.swipeToSwitchSessions;
    values["touch.gesture.swipeToSwitchPanes"] = gestures.swipeToSwitchPanes;
    values["touch.gesture.dragToScroll"] = gestures.dragToScroll;
    values["touch.gesture.pinchToZoom"] = gestures.pinchToZoom;
    values["touch.gesture.longPressPaneMenu"] = gestures.longPressPaneMenu;
  }
  if (Array.isArray(state.toolbarKeys)) {
    values["touch.toolbarKeys"] = mergeToolbarKeys(state.toolbarKeys as Partial<ToolbarKey>[])
      .filter((key) => key.visible)
      .map((key) => key.id);
  }
  return values;
}

/** Legacy values that pass their schema and differ from the default. */
function legacyChoices(): Values {
  const candidates: Values = {
    "appearance.theme": readTheme() ?? undefined,
    ...terminalValues(),
    ...settingsValues(),
  };
  const choices: Values = {};
  for (const key of SETTINGS_KEYS) {
    const value = parseSettingValue(key, candidates[key]);
    if (value === undefined || sameSettingValue(value, settingDefault(key))) continue;
    choices[key] = value;
  }
  return choices;
}

function writeDeviceChoices(choices: Values): void {
  const existing = readDeviceSettings();
  for (const key of Object.keys(choices) as SettingKey[]) {
    // A value already set on this device is newer than the legacy blob.
    if (!isDeviceSettingKey(key) || Object.hasOwn(existing, key)) continue;
    writeDeviceSetting(key, choices[key] as Settings[DeviceSettingKey]);
  }
}

/**
 * Overrides for the settings document from the legacy stores, or null when
 * they hold nothing to save. Device scope values are written to this
 * browser's device settings as a side effect. See the rule above.
 */
export function migrateLegacySettings(): SettingsDocument | null {
  const choices = legacyChoices();
  writeDeviceChoices(choices);
  const overrides: SettingsDocument = {};
  for (const key of Object.keys(choices) as SettingKey[]) {
    if (!isDeviceSettingKey(key)) overrides[key] = choices[key];
  }
  return Object.keys(overrides).length > 0 ? overrides : null;
}

/** Only the device scope part, for a browser whose server document is set. */
export function migrateLegacyDeviceSettings(): void {
  writeDeviceChoices(legacyChoices());
}

/**
 * Remove the legacy store blobs and mark the move done. `theme` stays as the
 * pre paint cache.
 */
export function finishLegacyMigration(): void {
  const store = storage();
  if (!store) return;
  try {
    store.removeItem(LEGACY_SETTINGS_KEY);
    store.removeItem(LEGACY_TERMINAL_KEY);
    store.setItem(LEGACY_MIGRATED_KEY, "1");
  } catch {
    // Blocked storage. The blobs are ignored from now on anyway.
  }
}
