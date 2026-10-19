import {
  SETTINGS_KEYS,
  isDeviceSettingKey,
  parseSettingValue,
  type DeviceSettingKey,
  type Settings,
} from "./settings-schema";

/**
 * Settings that belong to this browser, not to the user.
 *
 * Font size, editor zoom and GPU rendering differ between a phone and a
 * desktop, and the zoom shortcuts would otherwise write to the server on every
 * press. They live in localStorage under one key and win over the synced
 * document when settings resolve.
 *
 * Every value passes the same schema as the document. A hand edit or an old
 * value of the wrong type reads as missing. When storage is blocked or full,
 * values stay in memory for this page.
 */

export const DEVICE_SETTINGS_KEY = "tmuxde-device-settings";

export type DeviceSettings = Partial<Pick<Settings, DeviceSettingKey>>;

let memory: Record<string, unknown> = {};
let storageFailed = false;

function storage(): Storage | null {
  if (storageFailed) return null;
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    storageFailed = true;
    return null;
  }
}

function readRaw(): Record<string, unknown> {
  const store = storage();
  if (!store) return { ...memory };
  try {
    const text = store.getItem(DEVICE_SETTINGS_KEY);
    if (text === null) return {};
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch (error) {
    // Broken JSON reads as empty. A storage error moves to memory.
    if (error instanceof SyntaxError) return {};
    storageFailed = true;
    return { ...memory };
  }
}

function writeRaw(values: Record<string, unknown>): void {
  memory = { ...values };
  const store = storage();
  if (!store) return;
  try {
    if (Object.keys(values).length === 0) store.removeItem(DEVICE_SETTINGS_KEY);
    else store.setItem(DEVICE_SETTINGS_KEY, JSON.stringify(values));
  } catch {
    storageFailed = true;
  }
}

/** Valid device values only. Unknown keys and wrong types are skipped. */
export function readDeviceSettings(): DeviceSettings {
  const raw = readRaw();
  const values: Record<string, unknown> = {};
  for (const key of SETTINGS_KEYS) {
    if (!isDeviceSettingKey(key)) continue;
    const value = parseSettingValue(key, raw[key]);
    if (value !== undefined) values[key] = value;
  }
  return values as DeviceSettings;
}

/** Store one device value. Undefined removes it. Invalid values are ignored. */
export function writeDeviceSetting<K extends DeviceSettingKey>(
  key: K,
  value: Settings[K] | undefined,
): void {
  const values: Record<string, unknown> = { ...readDeviceSettings() };
  if (value === undefined) {
    if (!Object.hasOwn(values, key)) return;
    delete values[key];
  } else {
    const parsed = parseSettingValue(key, value);
    if (parsed === undefined || Object.is(values[key], parsed)) return;
    values[key] = parsed;
  }
  writeRaw(values);
}

export function clearDeviceSettings(): void {
  writeRaw({});
}

/** Forget the memory copy and the storage failure flag. */
export function resetDeviceSettingsForTests(): void {
  memory = {};
  storageFailed = false;
}
