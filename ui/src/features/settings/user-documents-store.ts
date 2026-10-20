import { create } from "zustand";
import { z } from "zod";
import { USER_DOCUMENT_NAMES, UserSettingsDocument, type UserDocumentName } from "@/protocol";
import {
  getUserDocument,
  putUserDocument,
  type UserDocumentResult,
} from "@/features/connection/user-documents-api";
import {
  validateSettingsDocument,
  type DocumentIssue,
  type SettingsDocument,
  type SettingsPatch,
} from "./settings-schema";

/**
 * The hub's two user documents, `settings` and `keybindings`, in one store.
 *
 * Text is kept exactly as the server holds it. Loads and saves for one
 * document run one at a time, so this browser never races its own `If-Match`.
 * A copy of both documents and their etags sits in localStorage, so settings
 * and bindings apply before the first fetch and while offline.
 *
 * After every successful load or save the document goes to its sink. The
 * settings bridge registers the settings sink and applies the resolved
 * values to the stores. The keymap registers the keybindings sink. Sinks keep
 * this file free of imports from those features.
 *
 * Conflict: a `412` reloads the server copy, which wins and applies. Status
 * turns `conflict` until `dismissConflict` or the next save.
 *
 * `updateSettings` waits out a pause before it saves. `flushSettingsSave`
 * ends the pause early, for a lock, a hidden page or an unmount. When no
 * other request for settings runs, it sends the PUT before it returns, so a
 * lock that drops the token right after cannot stop it.
 */

export const USER_DOCUMENTS_CACHE_KEY = "tmuxde-user-documents";
export const SETTINGS_SAVE_DELAY_MS = 750;
export const CONFLICT_MESSAGE = "Settings changed in another browser";

export type UserDocumentStatus = "idle" | "loading" | "ready" | "saving" | "conflict" | "error";

export interface UserDocumentState {
  /** Raw document text, as stored on the hub. */
  text: string;
  /** Etag of `text`. Null until a load or the cache provides one. */
  etag: string | null;
  status: UserDocumentStatus;
  lastError: string | null;
}

export type SaveOutcome = "saved" | "unchanged" | "conflict" | "invalid" | "error";

interface UserDocumentsStore {
  documents: Record<UserDocumentName, UserDocumentState>;
  /** Fetch the server copy. True when it arrived. */
  load: (name: UserDocumentName) => Promise<boolean>;
  /** Replace the whole document. Skips the request when the text is the same. */
  save: (name: UserDocumentName, text: string) => Promise<SaveOutcome>;
  /** Patch settings keys. Undefined deletes a key. Saves after a pause. */
  updateSettings: (patch: SettingsPatch) => void;
  /** A `settings:changed` broadcast. Reloads unless the etag is known. */
  noteChanged: (name: UserDocumentName, etag: string) => Promise<void>;
  /** Apply the cached copies. True when anything was cached. */
  hydrateFromCache: () => boolean;
  /** Back to ready after the user saw the server copy win. */
  dismissConflict: (name: UserDocumentName) => void;
}

const EMPTY_TEXT: Record<UserDocumentName, string> = { settings: "{}", keybindings: "[]" };

function emptyDocument(name: UserDocumentName): UserDocumentState {
  return {
    text: EMPTY_TEXT[name],
    etag: null,
    status: "idle",
    lastError: null,
  };
}

function emptyDocuments(): Record<UserDocumentName, UserDocumentState> {
  return { settings: emptyDocument("settings"), keybindings: emptyDocument("keybindings") };
}

type SettingsSink = (document: SettingsDocument) => void;
type KeybindingsSink = (text: string) => void;

let settingsSink: SettingsSink | null = null;
let keybindingsSink: KeybindingsSink | null = null;

/** Bumped by the test reset, so work from before it cannot land after it. */
let epoch = 0;
let chains: Record<UserDocumentName, Promise<unknown>> = {
  settings: Promise.resolve(),
  keybindings: Promise.resolve(),
};
/** Tasks queued or running per document. Zero means its chain is idle. */
let busy: Record<UserDocumentName, number> = { settings: 0, keybindings: 0 };
let pendingPatch: SettingsPatch = {};
let timer: ReturnType<typeof setTimeout> | null = null;

/**
 * Run `task` after the earlier tasks of the document. With `now`, an idle
 * chain runs it at once instead of on the next tick, so its request starts
 * before the caller returns.
 */
function serial<T>(name: UserDocumentName, task: () => Promise<T>, now = false): Promise<T> {
  const at = epoch;
  const idle = busy[name] === 0;
  busy[name] += 1;
  const counted = async () => {
    try {
      return await task();
    } finally {
      if (at === epoch) busy[name] -= 1;
    }
  };
  const run = now && idle ? counted() : chains[name].then(counted);
  chains[name] = run.catch(() => undefined);
  return run;
}

function current(name: UserDocumentName): UserDocumentState {
  return useUserDocumentsStore.getState().documents[name];
}

function update(name: UserDocumentName, at: number, partial: Partial<UserDocumentState>): void {
  if (at !== epoch) return;
  useUserDocumentsStore.setState((state) => ({
    documents: { ...state.documents, [name]: { ...state.documents[name], ...partial } },
  }));
}

function jsonIssue(text: string): DocumentIssue | null {
  try {
    JSON.parse(text);
    return null;
  } catch (error) {
    const reason = error instanceof Error ? error.message : "parse error";
    return { severity: "error", message: `Invalid JSON: ${reason}` };
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * Read settings text in two steps.
 *
 * The protocol schema checks the shape the hub accepts on PUT. Then
 * `validateSettingsDocument` checks each key against the registry. Both find
 * most problems, so a schema issue is added only for a key the registry check
 * found no error in. A file edited in a shell can fail the schema and still
 * apply its good keys. `valid` is false when the text is not a JSON object,
 * and the current values then stay.
 */
export function readSettingsText(text: string): {
  document: SettingsDocument;
  issues: DocumentIssue[];
  valid: boolean;
} {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    const reason = error instanceof Error ? error.message : "parse error";
    return {
      document: {},
      issues: [{ severity: "error", message: `Invalid JSON: ${reason}` }],
      valid: false,
    };
  }
  const shape = UserSettingsDocument.safeParse(data);
  const { document, issues } = validateSettingsDocument(shape.success ? shape.data : data);
  if (!isObject(data)) return { document, issues, valid: false };
  if (shape.success) return { document, issues, valid: true };

  const flagged = new Set(
    issues.filter((issue) => issue.severity === "error").map((issue) => issue.path),
  );
  for (const problem of shape.error.issues) {
    const [first] = problem.path;
    const path = typeof first === "string" ? first : undefined;
    if (flagged.has(path)) continue;
    flagged.add(path);
    issues.push({ severity: "error", message: problem.message, ...(path ? { path } : {}) });
  }
  return { document, issues, valid: true };
}

/**
 * A document with the unsaved patch on top. A reload that lands during the
 * pause before a save must not flip a value the user just changed.
 */
function withPendingPatch(document: SettingsDocument): SettingsDocument {
  const keys = Object.keys(pendingPatch);
  if (keys.length === 0) return document;
  const next = { ...document };
  for (const key of keys) {
    if (pendingPatch[key] === undefined) delete next[key];
    else next[key] = pendingPatch[key];
  }
  return next;
}

/** Hand a document to its sink. */
function deliver(name: UserDocumentName, text: string): void {
  if (name === "settings") {
    const parsed = readSettingsText(text);
    // Broken text leaves the current values alone rather than resetting them.
    if (parsed.valid) settingsSink?.(withPendingPatch(parsed.document));
    return;
  }
  keybindingsSink?.(text);
}

function failureMessage(result: Exclude<UserDocumentResult, { kind: "ok" }>): string {
  switch (result.kind) {
    case "conflict":
      return CONFLICT_MESSAGE;
    case "invalid":
      return result.message;
    case "unauthorized":
      return "Not signed in";
    case "notFound":
      return "Unknown document";
    case "tooLarge":
      return "Document is too large";
    case "network":
      return result.message;
  }
}

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

const CachedDocument = z.object({ text: z.string(), etag: z.string() });
const CacheSchema = z.object({
  settings: CachedDocument.optional(),
  keybindings: CachedDocument.optional(),
});

function writeCache(at: number): void {
  if (at !== epoch) return;
  const { documents } = useUserDocumentsStore.getState();
  const cache: Partial<Record<UserDocumentName, { text: string; etag: string }>> = {};
  for (const name of USER_DOCUMENT_NAMES) {
    const { text, etag } = documents[name];
    if (etag !== null) cache[name] = { text, etag };
  }
  try {
    storage()?.setItem(USER_DOCUMENTS_CACHE_KEY, JSON.stringify(cache));
  } catch {
    // Full or blocked storage. The server copy still applies.
  }
}

function readCache(): z.infer<typeof CacheSchema> | null {
  try {
    const text = storage()?.getItem(USER_DOCUMENTS_CACHE_KEY);
    if (!text) return null;
    const parsed = CacheSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Remove the cached copies, for device erase and disconnect. */
export function clearUserDocumentsCache(): void {
  try {
    storage()?.removeItem(USER_DOCUMENTS_CACHE_KEY);
  } catch {
    // Blocked storage holds no cache either.
  }
}

async function loadNow(name: UserDocumentName, at: number): Promise<boolean> {
  update(name, at, { status: "loading" });
  const result = await getUserDocument(name);
  if (at !== epoch) return false;
  if (result.kind !== "ok") {
    update(name, at, { status: "error", lastError: failureMessage(result) });
    return false;
  }
  deliver(name, result.text);
  update(name, at, { text: result.text, etag: result.etag, status: "ready", lastError: null });
  writeCache(at);
  return true;
}

/** A save needs an etag. Without one, fetch the server copy first. */
async function ensureEtag(name: UserDocumentName, at: number): Promise<boolean> {
  if (current(name).etag === null) await loadNow(name, at);
  return at === epoch && current(name).etag !== null;
}

/** The server copy, already loaded, won over this save. */
function refuse(name: UserDocumentName, at: number): SaveOutcome {
  update(name, at, { status: "conflict", lastError: CONFLICT_MESSAGE });
  return "conflict";
}

async function putNow(
  name: UserDocumentName,
  text: string,
  at: number,
  keepalive = false,
): Promise<SaveOutcome> {
  const before = current(name);
  if (text === before.text) {
    if (before.status === "conflict" || before.status === "error") {
      update(name, at, { status: "ready", lastError: null });
    }
    return "unchanged";
  }
  const syntax = jsonIssue(text);
  if (syntax) {
    update(name, at, { status: "error", lastError: syntax.message });
    return "invalid";
  }

  if (before.etag === null) return "error";
  update(name, at, { status: "saving" });
  const result = await putUserDocument(name, text, before.etag, keepalive ? { keepalive } : {});
  if (at !== epoch) return "error";

  switch (result.kind) {
    case "ok": {
      deliver(name, text);
      update(name, at, { text, etag: result.etag, status: "ready", lastError: null });
      writeCache(at);
      return "saved";
    }
    case "conflict":
      await loadNow(name, at);
      return refuse(name, at);
    case "invalid":
      update(name, at, { status: "error", lastError: result.message });
      return "invalid";
    default:
      update(name, at, { status: "error", lastError: failureMessage(result) });
      return "error";
  }
}

/**
 * Apply a patch to settings text.
 *
 * Null when the text is not a JSON object. Unknown keys stay. The result has
 * two space indent and a trailing newline. `changed` is false when the patch
 * sets nothing new, so the caller can skip the save.
 */
export function applySettingsPatch(
  text: string,
  patch: SettingsPatch,
): { text: string; changed: boolean } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const before = parsed as SettingsDocument;
  const next: SettingsDocument = { ...before };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete next[key];
    else next[key] = value;
  }
  return {
    text: `${JSON.stringify(next, null, 2)}\n`,
    changed: JSON.stringify(before) !== JSON.stringify(next),
  };
}

/**
 * Save the pending settings patch now instead of after the pause.
 *
 * With a known etag and no other settings request running, the PUT is sent
 * before this returns. Otherwise it waits its turn. `keepalive` lets the
 * request outlive the page, for page hide.
 */
export function flushSettingsSave(options: { keepalive?: boolean } = {}): Promise<SaveOutcome> {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
  const patch = pendingPatch;
  pendingPatch = {};
  const at = epoch;
  return serial(
    "settings",
    async () => {
      if (Object.keys(patch).length === 0) return "unchanged";
      // No await when the etag is known, so the PUT below starts at once.
      if (current("settings").etag === null && !(await ensureEtag("settings", at))) return "error";
      // Patch the newest text, which may have arrived during the pause.
      const next = applySettingsPatch(current("settings").text, patch);
      if (!next) {
        update("settings", at, {
          status: "error",
          lastError: "Settings file is not a JSON object. Import a working file or reset settings.",
        });
        return "invalid";
      }
      if (!next.changed) return "unchanged";
      return putNow("settings", next.text, at, options.keepalive === true);
    },
    true,
  );
}

export const useUserDocumentsStore = create<UserDocumentsStore>()(() => ({
  documents: emptyDocuments(),
  load: (name) => {
    const at = epoch;
    return serial(name, () => loadNow(name, at));
  },
  save: (name, text) => {
    const at = epoch;
    // The caller built the text from this copy. A reload that lands before
    // the PUT goes out brings a newer etag. Sending the text against it
    // would drop the other browser's change, so that counts as a conflict.
    const base = current(name).etag;
    return serial(name, async () => {
      if (!(await ensureEtag(name, at))) return "error";
      const now = current(name);
      if (base !== null && now.etag !== base && now.text !== text) return refuse(name, at);
      return putNow(name, text, at);
    });
  },
  updateSettings: (patch) => {
    pendingPatch = { ...pendingPatch, ...patch };
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => void flushSettingsSave(), SETTINGS_SAVE_DELAY_MS);
  },
  noteChanged: (name, etag) => {
    const at = epoch;
    // Queued behind a save in flight, so the broadcast of this browser's own
    // save finds its etag already known.
    return serial(name, async () => {
      if (current(name).etag === etag) return;
      await loadNow(name, at);
    });
  },
  hydrateFromCache: () => {
    const cache = readCache();
    if (!cache) return false;
    let hydrated = false;
    for (const name of USER_DOCUMENT_NAMES) {
      const entry = cache[name];
      // A server copy is newer than any cache.
      if (!entry || current(name).etag !== null) continue;
      deliver(name, entry.text);
      update(name, epoch, { text: entry.text, etag: entry.etag });
      hydrated = true;
    }
    return hydrated;
  },
  dismissConflict: (name) => {
    const doc = current(name);
    update(name, epoch, {
      status: doc.status === "conflict" ? "ready" : doc.status,
      lastError: doc.status === "conflict" ? null : doc.lastError,
    });
  },
}));

function deliverCurrent(name: UserDocumentName): void {
  const doc = current(name);
  if (doc.etag === null) return;
  deliver(name, doc.text);
}

/** The settings bridge applies each settings document through this. */
export function registerSettingsSink(sink: SettingsSink): () => void {
  settingsSink = sink;
  deliverCurrent("settings");
  return () => {
    if (settingsSink === sink) settingsSink = null;
  };
}

/** The keymap takes each keybindings text through this. */
export function registerKeybindingsSink(sink: KeybindingsSink): () => void {
  keybindingsSink = sink;
  deliverCurrent("keybindings");
  return () => {
    if (keybindingsSink === sink) keybindingsSink = null;
  };
}

export function resetUserDocumentsForTests(): void {
  epoch += 1;
  if (timer !== null) clearTimeout(timer);
  timer = null;
  pendingPatch = {};
  chains = { settings: Promise.resolve(), keybindings: Promise.resolve() };
  busy = { settings: 0, keybindings: 0 };
  settingsSink = null;
  keybindingsSink = null;
  useUserDocumentsStore.setState({ documents: emptyDocuments() });
}
