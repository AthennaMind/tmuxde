import { useEffect } from "react";
import { toast } from "sonner";
import { USER_DOCUMENT_NAMES, type ConnectionState, type UserDocumentName } from "@/protocol";
import { useConnectionStore } from "@/features/connection/connection-store";
import { readSelfHostedToken } from "@/features/connection/storage-keys";
import { onBeforeLock } from "@/features/lock/lock-controller";
import {
  applyKeybindingsText,
  type KeybindingIssue,
} from "@/features/keybindings/keybindings-store";
import { startSettingsBridge } from "./settings-bridge";
import {
  LEGACY_SETTINGS_KEY,
  LEGACY_TERMINAL_KEY,
  finishLegacyMigration,
  migrateLegacySettings,
} from "./settings-migration";
import type { DocumentIssue, SettingsDocument } from "./settings-schema";
import {
  CONFLICT_MESSAGE,
  flushSettingsSave,
  registerKeybindingsSink,
  useUserDocumentsStore,
  type SaveOutcome,
  type UserDocumentState,
} from "./user-documents-store";

/**
 * Wiring between the hub's user documents and the app.
 *
 * At module init, before the first render, the cached documents hydrate, the
 * settings bridge starts and the keymap registers as the keybindings sink. So
 * the terminal is built with the synced font and theme, and bindings work
 * before the first fetch and while offline. These links live as long as the
 * page.
 *
 * `useUserDocumentsSync` runs while the terminal layout is mounted. It loads
 * both documents on mount and when the browser comes back online, since the
 * hub serves them with no machine online. It loads again each time the socket
 * connects, which catches broadcasts missed while offline. It runs the legacy
 * migration once and shows toasts for conflicts and failed saves. `LockGate`
 * unmounts the layout while locked, so nothing loads then.
 *
 * A settings change waits out a pause before it saves. The pause ends early
 * when the page hides, when the layout unmounts and right before a lock, while
 * the token is still held. Otherwise a reload or a lock would lose the change
 * and the server copy would later bring the old value back.
 */

/** Load both documents when the socket has just connected and a token is held. */
export function shouldLoadDocuments(
  previous: ConnectionState | null,
  next: ConnectionState,
  hasToken: boolean,
): boolean {
  return hasToken && next === "connected" && previous !== "connected";
}

/**
 * Read the legacy stores on this page load. A browser that never synced may
 * hold old choices. So does one whose last move did not finish.
 */
export function shouldPrepareMigration(firstSync: boolean, hasLegacyStores: boolean): boolean {
  return firstSync || hasLegacyStores;
}

/** True for text that holds no settings: blank, or a JSON object without keys. */
export function isEmptySettingsText(text: string): boolean {
  if (!text.trim()) return true;
  try {
    const value: unknown = JSON.parse(text);
    return (
      !!value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).length === 0
    );
  } catch {
    return false;
  }
}

export type MigrationStep = { kind: "save"; text: string } | { kind: "finish" };

/**
 * Legacy overrides go only into an empty server document. A document with
 * content holds choices made in some browser, and old local values must not
 * replace them. The device part was written at boot either way.
 */
export function migrationStep(
  serverText: string,
  overrides: SettingsDocument | null,
): MigrationStep {
  if (!overrides || Object.keys(overrides).length === 0 || !isEmptySettingsText(serverText)) {
    return { kind: "finish" };
  }
  return { kind: "save", text: `${JSON.stringify(overrides, null, 2)}\n` };
}

/**
 * Remove the legacy stores after the save landed, or after another browser
 * saved first. Any other failure keeps them for the next page load.
 */
export function shouldFinishMigration(outcome: SaveOutcome): boolean {
  return outcome === "saved" || outcome === "unchanged" || outcome === "conflict";
}

export type DocumentToast =
  | { kind: "conflict"; message: string }
  | { kind: "error"; title: string; message: string };

const DOCUMENT_LABELS: Record<UserDocumentName, string> = {
  settings: "settings",
  keybindings: "keyboard shortcuts",
};

/**
 * The toast for one document's change of state, or null.
 *
 * A conflict always tells. An error tells unless a load failed. Then the
 * cache keeps serving and the connection banner already shows the cause.
 * A repeat of the same status stays quiet.
 */
export function documentToast(
  name: UserDocumentName,
  previous: UserDocumentState,
  next: UserDocumentState,
): DocumentToast | null {
  if (next.status === previous.status) return null;
  if (next.status === "conflict") return { kind: "conflict", message: CONFLICT_MESSAGE };
  if (next.status === "error" && previous.status !== "loading") {
    return {
      kind: "error",
      title: `Could not save ${DOCUMENT_LABELS[name]}`,
      message: next.lastError ?? "Save failed",
    };
  }
  return null;
}

/**
 * Keybinding issues in the shape the documents store keeps for the editor.
 * Paths read `[2].key`, as in the editor's Problems list.
 */
export function keybindingDocumentIssues(issues: readonly KeybindingIssue[]): DocumentIssue[] {
  return issues.map(({ index, field, message, severity }) => ({
    severity,
    message,
    ...(index === null ? {} : { path: field ? `[${index}].${field}` : `[${index}]` }),
  }));
}

function legacyStoresPresent(): boolean {
  try {
    if (typeof localStorage === "undefined") return false;
    return (
      localStorage.getItem(LEGACY_SETTINGS_KEY) !== null ||
      localStorage.getItem(LEGACY_TERMINAL_KEY) !== null
    );
  } catch {
    return false;
  }
}

/**
 * Legacy overrides read at boot, or null once handled.
 *
 * Read before any document applies. A load of the empty server document sets
 * the default theme, and the theme provider then overwrites the `theme` cache
 * the migration reads.
 */
let legacy: { overrides: SettingsDocument | null } | null = null;
let initialized = false;

/** Hydrate, migrate device values, start the bridge and the keymap sink. Idempotent. */
export function initUserDocuments(): void {
  if (initialized) return;
  initialized = true;
  useUserDocumentsStore.getState().hydrateFromCache();
  const firstSync = useUserDocumentsStore.getState().documents.settings.etag === null;
  if (shouldPrepareMigration(firstSync, legacyStoresPresent())) {
    // Device values land in this browser's device settings now, so the bridge
    // below applies them before the first render.
    legacy = { overrides: migrateLegacySettings() };
  }
  startSettingsBridge();
  registerKeybindingsSink((text) => keybindingDocumentIssues(applyKeybindingsText(text)));
  onBeforeLock(() => void flushSettingsSave());
}

async function migrateOnce(): Promise<void> {
  const pending = legacy;
  if (!pending) return;
  // One try per page load. A save is a mutation, and a failed one is not
  // replayed on the next connect.
  legacy = null;
  const store = useUserDocumentsStore.getState();
  const step = migrationStep(store.documents.settings.text, pending.overrides);
  if (step.kind === "finish") {
    finishLegacyMigration();
    return;
  }
  const outcome = await store.save("settings", step.text);
  // The server copy won. No editor holds the refused text, so drop it.
  if (outcome === "conflict") store.dismissConflict("settings");
  if (shouldFinishMigration(outcome)) finishLegacyMigration();
}

async function loadDocuments(): Promise<void> {
  const { load } = useUserDocumentsStore.getState();
  const [settingsLoaded] = await Promise.all([load("settings"), load("keybindings")]);
  if (settingsLoaded) await migrateOnce();
}

function showDocumentToast(name: UserDocumentName, note: DocumentToast): void {
  if (note.kind === "conflict") {
    toast.warning(note.message, { id: "user-documents-conflict" });
  } else {
    toast.error(note.title, { id: `user-documents-error-${name}`, description: note.message });
  }
}

/** Save a waiting settings change before the page goes away. */
function flushOnHide(): void {
  void flushSettingsSave({ keepalive: true });
}

function flushWhenHidden(): void {
  if (document.visibilityState === "hidden") flushOnHide();
}

/** Body of `useUserDocumentsSync`. Returns its cleanup. */
export function startUserDocumentsSync(): () => void {
  initUserDocuments();
  const loadWithToken = () => {
    if (readSelfHostedToken()) void loadDocuments();
  };
  loadWithToken();
  let previous: ConnectionState | null = useConnectionStore.getState().status;
  const onStatus = (status: ConnectionState) => {
    const load = shouldLoadDocuments(previous, status, !!readSelfHostedToken());
    previous = status;
    if (load) void loadDocuments();
  };
  const stopStatus = useConnectionStore.subscribe((state) => onStatus(state.status));
  const stopToasts = useUserDocumentsStore.subscribe((state, before) => {
    for (const name of USER_DOCUMENT_NAMES) {
      const note = documentToast(name, before.documents[name], state.documents[name]);
      if (note) showDocumentToast(name, note);
    }
  });
  const page = typeof window === "undefined" ? null : window;
  const view = typeof document === "undefined" ? null : document;
  page?.addEventListener("online", loadWithToken);
  page?.addEventListener("pagehide", flushOnHide);
  view?.addEventListener("visibilitychange", flushWhenHidden);
  return () => {
    page?.removeEventListener("online", loadWithToken);
    page?.removeEventListener("pagehide", flushOnHide);
    view?.removeEventListener("visibilitychange", flushWhenHidden);
    stopStatus();
    stopToasts();
    void flushSettingsSave();
  };
}

/** Load the user documents and save waiting changes while mounted. See the top of this file. */
export function useUserDocumentsSync(): void {
  useEffect(() => startUserDocumentsSync(), []);
}

initUserDocuments();
