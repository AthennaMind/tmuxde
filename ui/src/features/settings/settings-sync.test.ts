import { afterEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { getUserDocument, putUserDocument } from "@/features/connection/user-documents-api";
import { useConnectionStore } from "@/features/connection/connection-store";
import { useKeybindingsStore } from "@/features/keybindings/keybindings-store";
import {
  documentToast,
  isEmptySettingsText,
  migrationStep,
  shouldFinishMigration,
  shouldLoadDocuments,
  shouldPrepareMigration,
  startUserDocumentsSync,
} from "./settings-sync";
import { useSettingsStore } from "./settings-store";
import { getThemeSetting } from "./theme-setting";
import { lockNow } from "@/features/lock/lock-controller";
import { isUnlocked, setEnrolled, setMasterKey } from "@/features/lock/unlocked";
import {
  CONFLICT_MESSAGE,
  USER_DOCUMENTS_CACHE_KEY,
  useUserDocumentsStore,
  type UserDocumentState,
} from "./user-documents-store";
import { LEGACY_MIGRATED_KEY, LEGACY_SETTINGS_KEY } from "./settings-migration";

/** Keybindings text cached by an earlier page load. */
const KEYBINDINGS = JSON.stringify([
  { key: "ctrl+shift+b", command: "sidebar.toggle" },
  { key: "ctrl+j", command: "future.command" },
  { key: "ctrl + k", command: "palette.files" },
]);

/*
 * Storage as an upgraded browser leaves it, in place before the module
 * under test loads: cached keybindings, no cached settings, a legacy store
 * blob and a light theme. Hoisted code cannot read module constants, so the
 * keybindings text is spelled out again.
 */
const storage = vi.hoisted(() => {
  const map = new Map<string, string>();
  const memory: Storage = {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k: string) => map.get(k) ?? null,
    key: (i: number) => Array.from(map.keys())[i] ?? null,
    removeItem: (k: string) => void map.delete(k),
    setItem: (k: string, v: string) => void map.set(k, v),
  };
  memory.setItem(
    "tmuxde-user-documents",
    JSON.stringify({
      keybindings: {
        text: JSON.stringify([
          { key: "ctrl+shift+b", command: "sidebar.toggle" },
          { key: "ctrl+j", command: "future.command" },
          { key: "ctrl + k", command: "palette.files" },
        ]),
        etag: '"k1"',
      },
    }),
  );
  memory.setItem("ccremote-settings", JSON.stringify({ state: { wrapLines: true }, version: 0 }));
  memory.setItem("theme", "light");
  vi.stubGlobal("localStorage", memory);
  return memory;
});

vi.mock("@/features/connection/user-documents-api", () => ({
  getUserDocument: vi.fn(),
  putUserDocument: vi.fn(),
}));

vi.mock("@/features/connection/storage-keys", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/connection/storage-keys")>()),
  readSelfHostedToken: () => "token",
}));

vi.mock("sonner", () => ({ toast: { warning: vi.fn(), error: vi.fn() } }));

const get = vi.mocked(getUserDocument);
const put = vi.mocked(putUserDocument);

function state(partial: Partial<UserDocumentState>): UserDocumentState {
  return {
    text: "{}",
    etag: '"e"',
    status: "ready",
    lastError: null,
    ...partial,
  };
}

/** Let queued loads and saves settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("shouldLoadDocuments", () => {
  it("loads when the socket turns connected with a token", () => {
    expect(shouldLoadDocuments(null, "connected", true)).toBe(true);
    expect(shouldLoadDocuments("authenticating", "connected", true)).toBe(true);
    expect(shouldLoadDocuments("reconnecting", "connected", true)).toBe(true);
  });

  it("skips repeats, other states and a missing token", () => {
    expect(shouldLoadDocuments("connected", "connected", true)).toBe(false);
    expect(shouldLoadDocuments("connecting", "authenticating", true)).toBe(false);
    expect(shouldLoadDocuments("connected", "disconnected", true)).toBe(false);
    expect(shouldLoadDocuments(null, "connected", false)).toBe(false);
  });
});

describe("migration decisions", () => {
  it("reads legacy stores on a first sync or while they remain", () => {
    expect(shouldPrepareMigration(true, false)).toBe(true);
    expect(shouldPrepareMigration(false, true)).toBe(true);
    expect(shouldPrepareMigration(false, false)).toBe(false);
  });

  it("treats blank text and an object without keys as empty", () => {
    expect(isEmptySettingsText("{}")).toBe(true);
    expect(isEmptySettingsText(" {\n}\n")).toBe(true);
    expect(isEmptySettingsText("")).toBe(true);
    expect(isEmptySettingsText('{"files.wrapLines": true}')).toBe(false);
    expect(isEmptySettingsText("[]")).toBe(false);
    expect(isEmptySettingsText("{")).toBe(false);
  });

  it("saves overrides only into an empty server document", () => {
    expect(migrationStep("{}", { "files.wrapLines": true })).toEqual({
      kind: "save",
      text: '{\n  "files.wrapLines": true\n}\n',
    });
    expect(migrationStep('{"panes.autoZoom": false}', { "files.wrapLines": true })).toEqual({
      kind: "finish",
    });
    expect(migrationStep("{}", null)).toEqual({ kind: "finish" });
    expect(migrationStep("{}", {})).toEqual({ kind: "finish" });
  });

  it("removes the legacy stores unless the save failed", () => {
    expect(shouldFinishMigration("saved")).toBe(true);
    expect(shouldFinishMigration("unchanged")).toBe(true);
    expect(shouldFinishMigration("conflict")).toBe(true);
    expect(shouldFinishMigration("error")).toBe(false);
    expect(shouldFinishMigration("invalid")).toBe(false);
  });
});

describe("documentToast", () => {
  it("tells about a conflict once", () => {
    expect(
      documentToast("settings", state({ status: "ready" }), state({ status: "conflict" })),
    ).toEqual({ kind: "conflict", message: CONFLICT_MESSAGE });
    expect(
      documentToast("settings", state({ status: "conflict" }), state({ status: "conflict" })),
    ).toBeNull();
  });

  it("tells about a failed save with the server message", () => {
    expect(
      documentToast(
        "keybindings",
        state({ status: "saving" }),
        state({ status: "error", lastError: "Invalid document" }),
      ),
    ).toEqual({
      kind: "error",
      title: "Could not save keyboard shortcuts",
      message: "Invalid document",
    });
    expect(
      documentToast(
        "settings",
        state({ status: "ready" }),
        state({ status: "error", lastError: "Settings file is not a JSON object" }),
      ),
    ).toMatchObject({ kind: "error", title: "Could not save settings" });
  });

  it("stays quiet for a failed load and for other changes", () => {
    expect(
      documentToast(
        "settings",
        state({ status: "loading" }),
        state({ status: "error", lastError: "offline" }),
      ),
    ).toBeNull();
    expect(
      documentToast("settings", state({ status: "error" }), state({ status: "error" })),
    ).toBeNull();
    expect(
      documentToast("settings", state({ status: "saving" }), state({ status: "ready" })),
    ).toBeNull();
  });
});

/*
 * The tests below share the module's boot state and run in order. Boot read
 * the legacy blob and hydrated the cached keybindings.
 */
describe("boot", () => {
  it("applies cached keybindings through the keymap sink", () => {
    const keybindings = useKeybindingsStore.getState();
    expect(keybindings.userEntries).toEqual([
      { key: "ctrl+shift+b", command: "sidebar.toggle" },
      { key: "ctrl+j", command: "future.command" },
    ]);
    expect(keybindings.issues.map((issue) => [issue.index, issue.severity])).toEqual([
      [1, "warning"],
      [2, "error"],
    ]);
    const document = useUserDocumentsStore.getState().documents.keybindings;
    expect(document).toMatchObject({ text: KEYBINDINGS, etag: '"k1"' });
    // Nothing applied the empty settings document yet, so the theme stays.
    expect(getThemeSetting()).toBe("light");
  });

  it("loads both documents on mount and on connect, and moves legacy values once", async () => {
    const server = {
      settings: { text: "{}", etag: '"s0"' },
      keybindings: { text: "[]", etag: '"k2"' },
    };
    get.mockImplementation(async (name) => ({ kind: "ok", ...server[name] }));
    put.mockImplementation(async (name, text) => {
      server[name] = { text, etag: '"s1"' };
      return { kind: "ok", text, etag: '"s1"' };
    });

    // The hub serves the documents with no machine online, so the mount
    // loads them before any socket connects.
    useConnectionStore.setState({ status: "connecting" });
    const stop = startUserDocumentsSync();
    await vi.waitFor(() => expect(storage.getItem(LEGACY_SETTINGS_KEY)).toBeNull());

    expect(get.mock.calls.map(([name]) => name).sort()).toEqual(["keybindings", "settings"]);
    expect(put).toHaveBeenCalledTimes(1);
    expect(storage.getItem(LEGACY_MIGRATED_KEY)).toBe("1");
    const [name, text, etag] = put.mock.calls[0]!;
    expect([name, etag]).toEqual(["settings", '"s0"']);
    expect(JSON.parse(text)).toEqual({ "appearance.theme": "light", "files.wrapLines": true });
    expect(useSettingsStore.getState().wrapLines).toBe(true);
    expect(getThemeSetting()).toBe("light");
    expect(storage.getItem("theme")).toBe("light");
    expect(useKeybindingsStore.getState().userEntries).toEqual([]);
    const cache = JSON.parse(storage.getItem(USER_DOCUMENTS_CACHE_KEY)!);
    expect(cache.settings.etag).toBe('"s1"');

    // A connect loads again, to catch broadcasts missed so far. So does a
    // reconnect. The migration does not run twice.
    useConnectionStore.setState({ status: "connected" });
    await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(4));
    useConnectionStore.setState({ status: "reconnecting" });
    useConnectionStore.setState({ status: "connected" });
    await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(6));
    await settle();
    expect(put).toHaveBeenCalledTimes(1);
    stop();

    // Unmounted, a connect loads nothing.
    useConnectionStore.setState({ status: "disconnected" });
    useConnectionStore.setState({ status: "connected" });
    await settle();
    expect(get).toHaveBeenCalledTimes(6);
  });

  it("shows toasts for a conflict and for a refused save while mounted", async () => {
    const server = {
      settings: { text: '{"files.wrapLines": true}', etag: '"s2"' },
      keybindings: { text: "[]", etag: '"k2"' },
    };
    get.mockImplementation(async (name) => ({ kind: "ok", ...server[name] }));
    useConnectionStore.setState({ status: "connected" });
    const stop = startUserDocumentsSync();
    await settle();

    put.mockResolvedValueOnce({ kind: "conflict" });
    expect(
      await useUserDocumentsStore.getState().save("settings", '{"panes.autoZoom": false}'),
    ).toBe("conflict");
    expect(toast.warning).toHaveBeenCalledWith(CONFLICT_MESSAGE, expect.anything());

    put.mockResolvedValueOnce({ kind: "invalid", message: "Invalid document" });
    expect(await useUserDocumentsStore.getState().save("settings", '{"panes.autoZoom": 1}')).toBe(
      "invalid",
    );
    expect(toast.error).toHaveBeenCalledWith(
      "Could not save settings",
      expect.objectContaining({ description: "Invalid document" }),
    );
    stop();
  });

  it("loads when the browser comes online and saves a waiting change on hide", async () => {
    const server = {
      settings: { text: "{}", etag: '"s3"' },
      keybindings: { text: "[]", etag: '"k3"' },
    };
    get.mockImplementation(async (name) => ({ kind: "ok", ...server[name] }));
    put.mockImplementation(async (name, text) => {
      server[name] = { text, etag: `"p${put.mock.calls.length}"` };
      return { kind: "ok", text, etag: server[name].etag };
    });
    const page = new EventTarget();
    const view = Object.assign(new EventTarget(), { visibilityState: "visible" });
    vi.stubGlobal("window", page);
    vi.stubGlobal("document", view);
    try {
      useConnectionStore.setState({ status: "disconnected" });
      const stop = startUserDocumentsSync();
      await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(2));
      page.dispatchEvent(new Event("online"));
      await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(4));
      await settle();

      const { updateSettings } = useUserDocumentsStore.getState();
      updateSettings({ "terminal.cursorStyle": "bar" });
      page.dispatchEvent(new Event("pagehide"));
      // Sent at once and allowed to outlive the page.
      expect(put).toHaveBeenCalledTimes(1);
      expect(put.mock.calls[0]?.[3]).toEqual({ keepalive: true });
      await settle();

      updateSettings({ "terminal.cursorStyle": "underline" });
      view.dispatchEvent(new Event("visibilitychange"));
      expect(put).toHaveBeenCalledTimes(1);
      view.visibilityState = "hidden";
      view.dispatchEvent(new Event("visibilitychange"));
      expect(put).toHaveBeenCalledTimes(2);
      await settle();

      // The unmount saves what is still waiting, then the page events stop.
      updateSettings({ "terminal.cursorStyle": "block" });
      stop();
      expect(put).toHaveBeenCalledTimes(3);
      expect(JSON.parse(put.mock.calls[2]![1])).toEqual({ "terminal.cursorStyle": "block" });
      await settle();
      page.dispatchEvent(new Event("online"));
      await settle();
      expect(get).toHaveBeenCalledTimes(4);
    } finally {
      vi.stubGlobal("window", undefined);
      vi.stubGlobal("document", undefined);
    }
  });

  it("saves a waiting change before a lock drops the token", async () => {
    const server = {
      settings: { text: "{}", etag: '"s4"' },
      keybindings: { text: "[]", etag: '"k4"' },
    };
    get.mockImplementation(async (name) => ({ kind: "ok", ...server[name] }));
    const unlockedAtPut: boolean[] = [];
    put.mockImplementation(async (name, text) => {
      unlockedAtPut.push(isUnlocked());
      server[name] = { text, etag: '"s5"' };
      return { kind: "ok", text, etag: '"s5"' };
    });
    await useUserDocumentsStore.getState().load("settings");
    setEnrolled(true);
    setMasterKey(new Uint8Array(32).fill(1));
    try {
      useUserDocumentsStore.getState().updateSettings({ "terminal.cursorBlink": false });
      lockNow("manual");
      expect(isUnlocked()).toBe(false);
      expect(put).toHaveBeenCalledTimes(1);
      expect(unlockedAtPut).toEqual([true]);
      await settle();
      expect(JSON.parse(server.settings.text)).toEqual({ "terminal.cursorBlink": false });
      expect(useUserDocumentsStore.getState().documents.settings.etag).toBe('"s5"');
    } finally {
      setEnrolled(false);
    }
  });
});
