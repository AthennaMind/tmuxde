import { clampCodeZoom, clampFontSize, useTerminalStore } from "@/features/terminal/terminal-store";
import { defaultToolbarKeys, mergeToolbarKeys, useSettingsStore } from "./settings-store";
import {
  isDeviceSettingKey,
  resolveSettings,
  sameSettingValue,
  settingDefault,
  type DeviceSettingKey,
  type SettingKey,
  type Settings,
  type SettingsPatch,
} from "./settings-schema";
import { readDeviceSettings, writeDeviceSetting } from "./device-settings";
import { getThemeSetting, setThemeSetting, subscribeThemeSetting } from "./theme-setting";
import { registerSettingsSink, useUserDocumentsStore } from "./user-documents-store";

/**
 * Two way link between resolved settings and the stores the app reads.
 *
 * `applySettings` writes resolved values into `useTerminalStore`,
 * `useSettingsStore` and the theme setting under an applying flag. Nothing
 * written during apply goes back, so clamping a font size on a small screen
 * never reaches the server.
 *
 * The subscriptions catch changes made through store actions. A key is
 * written only when its value changed in that update and differs from the
 * last resolved value. User scope keys go to the settings document through
 * `updateSettings`. Device scope keys go to `device-settings`. Applying a
 * document yields values that already match, so the loop ends there.
 */

type TerminalState = ReturnType<typeof useTerminalStore.getState>;
type SettingsState = ReturnType<typeof useSettingsStore.getState>;
type Values = Partial<Record<SettingKey, unknown>>;

let applying = false;
let lastResolved: Values = {};
let stops: (() => void)[] = [];

function terminalValues(state: TerminalState): Values {
  return {
    "terminal.theme": state.themeName,
    "terminal.fontSize": state.fontSize,
    "terminal.fontFamily": state.fontFamily,
    "terminal.fontWeight": state.terminalWeight,
    "terminal.cursorStyle": state.cursorStyle,
    "terminal.cursorBlink": state.cursorBlink,
    "terminal.copyOnSelect": state.copyOnSelect,
    "terminal.scrollback": state.scrollback,
    "terminal.gpuRendering": state.gpuRendering,
    "editor.fontWeight": state.codeWeight,
    "editor.zoom": state.codeZoom,
  };
}

function settingsValues(state: SettingsState): Values {
  return {
    "panes.autoZoom": state.autoZoom,
    "panes.showIndexes": state.showPaneIndexes,
    "files.wrapLines": state.wrapLines,
    "files.markdownPreview": state.markdownPreview,
    "changes.filterPatterns": state.commitFilterPatterns,
    "changes.filterMode": state.commitFilterMode,
    "touch.haptics": state.hapticEnabled,
    "touch.gesture.swipeToSwitchSessions": state.gestures.swipeToSwitchSessions,
    "touch.gesture.swipeToSwitchPanes": state.gestures.swipeToSwitchPanes,
    "touch.gesture.dragToScroll": state.gestures.dragToScroll,
    "touch.gesture.pinchToZoom": state.gestures.pinchToZoom,
    "touch.gesture.longPressPaneMenu": state.gestures.longPressPaneMenu,
    "touch.toolbarKeys": state.toolbarKeys.filter((key) => key.visible).map((key) => key.id),
  };
}

/** Current values of every key, read from the stores. */
export function settingsFromStores(): Settings {
  return {
    ...terminalValues(useTerminalStore.getState()),
    ...settingsValues(useSettingsStore.getState()),
    "appearance.theme": getThemeSetting(),
  } as Settings;
}

/** Only the fields that differ, so an unchanged apply does not render. */
function changedFields<T extends object>(state: T, next: Partial<T>): Partial<T> {
  const patch: Partial<T> = {};
  for (const field of Object.keys(next) as (keyof T)[]) {
    if (!sameSettingValue(state[field], next[field])) patch[field] = next[field];
  }
  return patch;
}

function applyTerminal(settings: Settings): void {
  const state = useTerminalStore.getState();
  const patch = changedFields<TerminalState>(state, {
    themeName: settings["terminal.theme"],
    fontSize: clampFontSize(settings["terminal.fontSize"]),
    fontFamily: settings["terminal.fontFamily"],
    terminalWeight: settings["terminal.fontWeight"],
    cursorStyle: settings["terminal.cursorStyle"],
    cursorBlink: settings["terminal.cursorBlink"],
    copyOnSelect: settings["terminal.copyOnSelect"],
    scrollback: settings["terminal.scrollback"],
    gpuRendering: settings["terminal.gpuRendering"],
    codeWeight: settings["editor.fontWeight"],
    codeZoom: clampCodeZoom(settings["editor.zoom"]),
  });
  if (Object.keys(patch).length > 0) useTerminalStore.setState(patch);
}

function applySettingsStore(settings: Settings): void {
  const state = useSettingsStore.getState();
  const gestures = {
    swipeToSwitchSessions: settings["touch.gesture.swipeToSwitchSessions"],
    swipeToSwitchPanes: settings["touch.gesture.swipeToSwitchPanes"],
    dragToScroll: settings["touch.gesture.dragToScroll"],
    pinchToZoom: settings["touch.gesture.pinchToZoom"],
    longPressPaneMenu: settings["touch.gesture.longPressPaneMenu"],
  };
  const visible = new Set(settings["touch.toolbarKeys"]);
  const patch = changedFields<SettingsState>(state, {
    autoZoom: settings["panes.autoZoom"],
    showPaneIndexes: settings["panes.showIndexes"],
    wrapLines: settings["files.wrapLines"],
    markdownPreview: settings["files.markdownPreview"],
    commitFilterPatterns: settings["changes.filterPatterns"],
    commitFilterMode: settings["changes.filterMode"],
    hapticEnabled: settings["touch.haptics"],
    gestures,
  });
  const shown = state.toolbarKeys.filter((key) => key.visible).map((key) => key.id);
  if (!sameSettingValue(shown, settings["touch.toolbarKeys"])) {
    patch.toolbarKeys = mergeToolbarKeys(
      defaultToolbarKeys.map(({ id }) => ({ id, visible: visible.has(id) })),
    );
  }
  if (Object.keys(patch).length > 0) useSettingsStore.setState(patch);
}

/** Write resolved settings into the stores. Never writes back. */
export function applySettings(settings: Settings): void {
  lastResolved = { ...settings };
  applying = true;
  try {
    applyTerminal(settings);
    applySettingsStore(settings);
    setThemeSetting(settings["appearance.theme"], "sync");
  } finally {
    applying = false;
  }
}

/** Write the keys that changed from `previous` to `next` back to their home. */
function writeBack(previous: Values, next: Values): void {
  if (applying) return;
  const patch: SettingsPatch = {};
  let userKeys = 0;
  for (const key of Object.keys(next) as SettingKey[]) {
    const value = next[key];
    if (sameSettingValue(previous[key], value)) continue;
    if (Object.hasOwn(lastResolved, key) && sameSettingValue(lastResolved[key], value)) continue;
    lastResolved[key] = value;
    if (isDeviceSettingKey(key)) {
      writeDeviceSetting(key, value as Settings[DeviceSettingKey]);
      continue;
    }
    // The document keeps overrides only. A default deletes the key.
    patch[key] = sameSettingValue(value, settingDefault(key)) ? undefined : value;
    userKeys += 1;
  }
  if (userKeys > 0) useUserDocumentsStore.getState().updateSettings(patch);
}

/**
 * Start the link. Idempotent. Returns `stopSettingsBridge`.
 *
 * Applies this device's values first. Then registers as the documents
 * store's settings sink, so every loaded, saved or cached document applies
 * here, starting with the one already held.
 */
export function startSettingsBridge(): () => void {
  if (stops.length > 0) return stopSettingsBridge;
  // This device's own values apply even before any document is held.
  applySettings({ ...settingsFromStores(), ...readDeviceSettings() });
  let theme = getThemeSetting();
  stops = [
    useTerminalStore.subscribe((state, previous) =>
      writeBack(terminalValues(previous), terminalValues(state)),
    ),
    useSettingsStore.subscribe((state, previous) =>
      writeBack(settingsValues(previous), settingsValues(state)),
    ),
    subscribeThemeSetting((origin) => {
      const previous = theme;
      theme = getThemeSetting();
      if (applying) return;
      // Another tab chose it and saved it. Adopt it, do not write it again.
      if (origin === "sync") {
        lastResolved["appearance.theme"] = theme;
        return;
      }
      writeBack({ "appearance.theme": previous }, { "appearance.theme": theme });
    }),
    registerSettingsSink((document) =>
      applySettings(resolveSettings(document, readDeviceSettings())),
    ),
  ];
  return stopSettingsBridge;
}

export function stopSettingsBridge(): void {
  for (const stop of stops) stop();
  stops = [];
  lastResolved = {};
  applying = false;
}
