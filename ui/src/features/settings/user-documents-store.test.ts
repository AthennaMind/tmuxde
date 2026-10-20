import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getUserDocument, putUserDocument } from "@/features/connection/user-documents-api";
import {
  CONFLICT_MESSAGE,
  SETTINGS_SAVE_DELAY_MS,
  USER_DOCUMENTS_CACHE_KEY,
  applySettingsPatch,
  clearUserDocumentsCache,
  flushSettingsSave,
  readSettingsText,
  registerKeybindingsSink,
  registerSettingsSink,
  resetUserDocumentsForTests,
  useUserDocumentsStore,
} from "./user-documents-store";

vi.mock("@/features/connection/user-documents-api", () => ({
  getUserDocument: vi.fn(),
  putUserDocument: vi.fn(),
}));

const get = vi.mocked(getUserDocument);
const put = vi.mocked(putUserDocument);

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k: string) => map.get(k) ?? null,
    key: (i: number) => Array.from(map.keys())[i] ?? null,
    removeItem: (k: string) => void map.delete(k),
    setItem: (k: string, v: string) => void map.set(k, v),
  };
}

let storage: Storage;
let etagCounter = 0;

/** A fake hub: one text per document, a fresh etag per write. */
function serve(initial: { settings?: string; keybindings?: string } = {}) {
  const server = {
    settings: { text: initial.settings ?? "{}", etag: '"s0"' },
    keybindings: { text: initial.keybindings ?? "[]", etag: '"k0"' },
  };
  get.mockImplementation(async (name) => ({ kind: "ok", ...server[name] }));
  put.mockImplementation(async (name, text, etag) => {
    if (etag !== server[name].etag && etag !== "*") return { kind: "conflict" };
    etagCounter += 1;
    server[name] = { text, etag: `"w${etagCounter}"` };
    return { kind: "ok", text, etag: server[name].etag };
  });
  return server;
}

const settings = () => useUserDocumentsStore.getState().documents.settings;
const store = () => useUserDocumentsStore.getState();

beforeEach(() => {
  storage = memoryStorage();
  vi.stubGlobal("localStorage", storage);
  resetUserDocumentsForTests();
  get.mockReset();
  put.mockReset();
});

afterEach(() => {
  resetUserDocumentsForTests();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("load", () => {
  it("stores text and etag, applies settings and caches both", async () => {
    serve({ settings: '{"files.wrapLines": true}' });
    const sink = vi.fn();
    registerSettingsSink(sink);
    expect(await store().load("settings")).toBe(true);
    expect(settings()).toMatchObject({
      text: '{"files.wrapLines": true}',
      etag: '"s0"',
      status: "ready",
    });
    expect(sink).toHaveBeenCalledWith({ "files.wrapLines": true });
    expect(JSON.parse(storage.getItem(USER_DOCUMENTS_CACHE_KEY)!)).toEqual({
      settings: { text: '{"files.wrapLines": true}', etag: '"s0"' },
    });
  });

  it("keeps current values when the text is broken", async () => {
    serve({ settings: "{" });
    const sink = vi.fn();
    registerSettingsSink(sink);
    await store().load("settings");
    expect(sink).not.toHaveBeenCalled();
    expect(settings()).toMatchObject({ text: "{", status: "ready" });
  });

  it("sends keybindings text to the keybindings sink", async () => {
    serve({ keybindings: '[{"key": "ctrl+k", "command": "palette.commands"}]' });
    const sink = vi.fn();
    registerKeybindingsSink(sink);
    await store().load("keybindings");
    expect(sink).toHaveBeenCalledWith('[{"key": "ctrl+k", "command": "palette.commands"}]');
  });

  it("marks an error and keeps the text when the hub is unreachable", async () => {
    get.mockResolvedValue({ kind: "network", message: "offline" });
    expect(await store().load("settings")).toBe(false);
    expect(settings()).toMatchObject({ status: "error", lastError: "offline", text: "{}" });
  });
});

describe("readSettingsText", () => {
  it("passes a document the hub accepts through the registry check", () => {
    const read = readSettingsText('{"files.wrapLines": true, "future.option": 1}');
    expect(read.valid).toBe(true);
    expect(read.document).toEqual({ "files.wrapLines": true, "future.option": 1 });
    expect(read.issues).toEqual([
      { severity: "warning", path: "future.option", message: "Unknown setting. It is kept." },
    ]);
  });

  it("applies the good keys of a file the hub schema refuses, one issue per key", () => {
    const read = readSettingsText('{"files.wrapLines": true, "Bad": 1}');
    expect(read.valid).toBe(true);
    expect(read.document["files.wrapLines"]).toBe(true);
    expect(read.issues.map((issue) => [issue.path, issue.severity])).toEqual([["Bad", "error"]]);
  });

  it("marks text that is not a JSON object as invalid", () => {
    expect(readSettingsText("{").valid).toBe(false);
    expect(readSettingsText("[]")).toMatchObject({ valid: false, document: {} });
    expect(readSettingsText("[]").issues).toHaveLength(1);
  });

  it("feeds the settings sink with the good keys of a refused file", async () => {
    serve({ settings: '{"files.wrapLines": true, "Bad": 1}' });
    const sink = vi.fn();
    registerSettingsSink(sink);
    await store().load("settings");
    expect(sink).toHaveBeenCalledWith({ "files.wrapLines": true, Bad: 1 });
  });
});

describe("cache", () => {
  it("hydrates both documents before the first fetch", () => {
    storage.setItem(
      USER_DOCUMENTS_CACHE_KEY,
      JSON.stringify({
        settings: { text: '{"panes.autoZoom": false}', etag: '"c1"' },
        keybindings: { text: "[]", etag: '"c2"' },
      }),
    );
    const settingsSink = vi.fn();
    const keybindingsSink = vi.fn();
    registerSettingsSink(settingsSink);
    registerKeybindingsSink(keybindingsSink);
    expect(store().hydrateFromCache()).toBe(true);
    expect(settings()).toMatchObject({ etag: '"c1"', status: "idle" });
    expect(settingsSink).toHaveBeenCalledWith({ "panes.autoZoom": false });
    expect(keybindingsSink).toHaveBeenCalledWith("[]");
  });

  it("delivers a cached document to a sink registered later", () => {
    storage.setItem(
      USER_DOCUMENTS_CACHE_KEY,
      JSON.stringify({ settings: { text: '{"touch.haptics": false}', etag: '"c1"' } }),
    );
    store().hydrateFromCache();
    const sink = vi.fn();
    registerSettingsSink(sink);
    expect(sink).toHaveBeenCalledWith({ "touch.haptics": false });
  });

  it("ignores a broken cache and clears it", () => {
    storage.setItem(USER_DOCUMENTS_CACHE_KEY, '{"settings": 3}');
    expect(store().hydrateFromCache()).toBe(false);
    clearUserDocumentsCache();
    expect(storage.getItem(USER_DOCUMENTS_CACHE_KEY)).toBeNull();
  });

  it("never replaces a server copy with the cache", async () => {
    serve({ settings: '{"touch.haptics": false}' });
    await store().load("settings");
    storage.setItem(
      USER_DOCUMENTS_CACHE_KEY,
      JSON.stringify({ settings: { text: "{}", etag: '"old"' } }),
    );
    expect(store().hydrateFromCache()).toBe(false);
    expect(settings().etag).toBe('"s0"');
  });
});

describe("updateSettings", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("debounces patches into one save", async () => {
    const server = serve({ settings: '{"future.key": 1}' });
    await store().load("settings");
    store().updateSettings({ "terminal.cursorBlink": false });
    await vi.advanceTimersByTimeAsync(SETTINGS_SAVE_DELAY_MS - 1);
    store().updateSettings({ "files.wrapLines": true });
    await vi.advanceTimersByTimeAsync(SETTINGS_SAVE_DELAY_MS - 1);
    expect(put).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(put).toHaveBeenCalledTimes(1);
    expect(server.settings.text).toBe(
      '{\n  "future.key": 1,\n  "terminal.cursorBlink": false,\n  "files.wrapLines": true\n}\n',
    );
    expect(settings()).toMatchObject({ status: "ready", etag: server.settings.etag });
  });

  it("deletes keys patched to undefined", async () => {
    const server = serve({ settings: '{"files.wrapLines": true, "touch.haptics": false}' });
    await store().load("settings");
    store().updateSettings({ "files.wrapLines": undefined });
    await vi.advanceTimersByTimeAsync(SETTINGS_SAVE_DELAY_MS);
    expect(JSON.parse(server.settings.text)).toEqual({ "touch.haptics": false });
  });

  it("skips the save when nothing changes", async () => {
    serve({ settings: '{"files.wrapLines": true}' });
    await store().load("settings");
    store().updateSettings({ "files.wrapLines": true, "touch.haptics": undefined });
    await vi.advanceTimersByTimeAsync(SETTINGS_SAVE_DELAY_MS);
    expect(put).not.toHaveBeenCalled();
    expect(await flushSettingsSave()).toBe("unchanged");
  });

  it("loads first when no etag is known yet", async () => {
    const server = serve({ settings: '{"touch.haptics": false}' });
    store().updateSettings({ "files.wrapLines": true });
    await vi.advanceTimersByTimeAsync(SETTINGS_SAVE_DELAY_MS);
    expect(get).toHaveBeenCalledTimes(1);
    expect(JSON.parse(server.settings.text)).toEqual({
      "touch.haptics": false,
      "files.wrapLines": true,
    });
  });

  it("applies the saved document to the settings sink", async () => {
    serve();
    await store().load("settings");
    const sink = vi.fn();
    registerSettingsSink(sink);
    store().updateSettings({ "panes.showIndexes": false });
    await vi.advanceTimersByTimeAsync(SETTINGS_SAVE_DELAY_MS);
    expect(sink).toHaveBeenLastCalledWith({ "panes.showIndexes": false });
  });

  it("keeps an unsaved change on top of a reload during the pause", async () => {
    const server = serve();
    await store().load("settings");
    const sink = vi.fn();
    registerSettingsSink(sink);
    store().updateSettings({ "files.wrapLines": true });
    server.settings = { text: '{"touch.haptics": false}', etag: '"other"' };
    await store().noteChanged("settings", '"other"');
    expect(sink).toHaveBeenLastCalledWith({ "touch.haptics": false, "files.wrapLines": true });
    await vi.advanceTimersByTimeAsync(SETTINGS_SAVE_DELAY_MS);
    expect(JSON.parse(server.settings.text)).toEqual({
      "touch.haptics": false,
      "files.wrapLines": true,
    });
  });

  it("sends the pending patch before flush returns, with keepalive on request", async () => {
    const server = serve({ settings: '{"future.key": 1}' });
    await store().load("settings");
    store().updateSettings({ "terminal.cursorStyle": "bar" });
    const done = flushSettingsSave({ keepalive: true });
    // Already sent, so a lock that drops the token next cannot stop it.
    expect(put).toHaveBeenCalledTimes(1);
    expect(put.mock.calls[0]![3]).toEqual({ keepalive: true });
    expect(await done).toBe("saved");
    expect(JSON.parse(server.settings.text)).toEqual({
      "future.key": 1,
      "terminal.cursorStyle": "bar",
    });
    // The pause ended with the flush. No second save follows.
    await vi.advanceTimersByTimeAsync(SETTINGS_SAVE_DELAY_MS);
    expect(put).toHaveBeenCalledTimes(1);
  });

  it("queues a flush behind a save in flight, then sends at once again", async () => {
    const server = serve();
    await store().load("settings");
    const hub = put.getMockImplementation()!;
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    put.mockImplementationOnce(async (...args) => {
      await gate;
      return hub(...args);
    });
    const first = store().save("settings", '{"files.wrapLines": true}\n');
    await vi.waitFor(() => expect(put).toHaveBeenCalledTimes(1));

    store().updateSettings({ "touch.haptics": false });
    const flushed = flushSettingsSave();
    await Promise.resolve();
    expect(put).toHaveBeenCalledTimes(1);
    release();
    expect(await first).toBe("saved");
    expect(await flushed).toBe("saved");
    expect(put).toHaveBeenCalledTimes(2);
    expect(JSON.parse(server.settings.text)).toEqual({
      "files.wrapLines": true,
      "touch.haptics": false,
    });

    // Idle again, so the next flush sends before it returns.
    store().updateSettings({ "panes.autoZoom": false });
    void flushSettingsSave();
    expect(put).toHaveBeenCalledTimes(3);
  });

  it("refuses to patch text that is not an object", async () => {
    serve({ settings: "[1]" });
    await store().load("settings");
    store().updateSettings({ "files.wrapLines": true });
    await vi.advanceTimersByTimeAsync(SETTINGS_SAVE_DELAY_MS);
    expect(put).not.toHaveBeenCalled();
    expect(settings().status).toBe("error");
  });
});

describe("conflict", () => {
  it("reloads the server copy, which wins", async () => {
    const server = serve({ settings: '{"files.wrapLines": true}' });
    await store().load("settings");
    // Another browser saves in between.
    server.settings = { text: '{"touch.haptics": false}', etag: '"other"' };
    const sink = vi.fn();
    registerSettingsSink(sink);
    const mine = '{"files.wrapLines": false}';
    expect(await store().save("settings", mine)).toBe("conflict");
    expect(settings()).toMatchObject({
      status: "conflict",
      text: '{"touch.haptics": false}',
      etag: '"other"',
      lastError: CONFLICT_MESSAGE,
    });
    expect(sink).toHaveBeenLastCalledWith({ "touch.haptics": false });
  });

  it("overwrites with the refused text against the fresh etag", async () => {
    const server = serve();
    await store().load("settings");
    server.settings = { text: '{"touch.haptics": false}', etag: '"other"' };
    const mine = '{"files.wrapLines": false}';
    await store().save("settings", mine);
    expect(await store().save("settings", mine)).toBe("saved");
    expect(server.settings.text).toBe(mine);
    expect(settings()).toMatchObject({ status: "ready", lastError: null });
  });

  it("refuses text built from a copy that a reload replaced before the PUT", async () => {
    const server = serve();
    await store().load("settings");
    server.settings = { text: '{"touch.haptics": false}', etag: '"other"' };
    // The broadcast reload is queued first. The save was built from "{}".
    const noted = store().noteChanged("settings", '"other"');
    const mine = '{"files.wrapLines": true}';
    const saving = store().save("settings", mine);
    await noted;
    expect(await saving).toBe("conflict");
    expect(put).not.toHaveBeenCalled();
    expect(server.settings.text).toBe('{"touch.haptics": false}');
    expect(settings()).toMatchObject({
      status: "conflict",
      etag: '"other"',
      lastError: CONFLICT_MESSAGE,
    });
  });

  it("dismisses the conflict", async () => {
    const server = serve();
    await store().load("settings");
    server.settings = { text: '{"touch.haptics": false}', etag: '"other"' };
    await store().save("settings", '{"files.wrapLines": false}');
    store().dismissConflict("settings");
    expect(settings()).toMatchObject({ status: "ready", lastError: null });
  });
});

describe("save", () => {
  it("does not send broken JSON", async () => {
    serve();
    await store().load("settings");
    expect(await store().save("settings", "{")).toBe("invalid");
    expect(put).not.toHaveBeenCalled();
    expect(settings().status).toBe("error");
  });

  it("shows the server's reason for an invalid document", async () => {
    serve();
    await store().load("keybindings");
    put.mockResolvedValueOnce({ kind: "invalid", message: "entry 0: unknown field" });
    expect(await store().save("keybindings", '[{"x": 1}]')).toBe("invalid");
    expect(store().documents.keybindings).toMatchObject({
      status: "error",
      lastError: "entry 0: unknown field",
      text: "[]",
    });
  });

  it("skips a save of the same text", async () => {
    serve({ keybindings: "[]" });
    await store().load("keybindings");
    expect(await store().save("keybindings", "[]")).toBe("unchanged");
    expect(put).not.toHaveBeenCalled();
  });
});

describe("noteChanged", () => {
  it("reloads when the etag is new", async () => {
    const server = serve();
    await store().load("settings");
    server.settings = { text: '{"touch.haptics": false}', etag: '"other"' };
    await store().noteChanged("settings", '"other"');
    expect(settings().text).toBe('{"touch.haptics": false}');
    expect(get).toHaveBeenCalledTimes(2);
  });

  it("ignores the broadcast of this browser's own save", async () => {
    serve();
    await store().load("settings");
    const own = `"w${etagCounter + 1}"`;
    const saving = store().save("settings", '{"touch.haptics": false}');
    // The broadcast can arrive before the PUT answer. It waits for the save.
    const noted = store().noteChanged("settings", own);
    await Promise.all([saving, noted]);
    expect(settings().etag).toBe(own);
    expect(get).toHaveBeenCalledTimes(1);
  });
});

describe("applySettingsPatch", () => {
  it("keeps key order and unknown keys", () => {
    expect(applySettingsPatch('{"b": 1, "a": 2}', { b: 3, c: 4 })).toEqual({
      text: '{\n  "b": 3,\n  "a": 2,\n  "c": 4\n}\n',
      changed: true,
    });
  });

  it("is null for text that is not an object", () => {
    expect(applySettingsPatch("[]", {})).toBeNull();
    expect(applySettingsPatch("{", {})).toBeNull();
  });
});
