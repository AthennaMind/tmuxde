import {
  KeybindingsDocument,
  USER_DOCUMENT_MAX_BYTES,
  UserSettingsDocument,
  type UserDocumentName,
} from "@/protocol";
import { parseKeybindingsDocument } from "@/features/keybindings/keybindings-store";
import { validateSettingsDocument, type DocumentIssue } from "./settings-schema";

/**
 * Checks for a settings or keybindings text before it is saved, for the
 * JSON editor and for import.
 *
 * Two layers. The protocol schemas hold the hub's structural rules, so they
 * decide `valid`: false means the hub would refuse the text. The feature
 * validators know keys, values, chords and commands, so their issues are the
 * ones shown. A wrong value is still valid. The app ignores it and says so.
 */

export interface DocumentCheck {
  /** JSON parses and the hub's structural rules hold. */
  valid: boolean;
  /** Keys in settings, entries in keybindings. Zero when the text does not parse. */
  count: number;
  issues: DocumentIssue[];
}

const MAX_KB = Math.round(USER_DOCUMENT_MAX_BYTES / 1024);

const TOO_LARGE: DocumentIssue = {
  severity: "error",
  message: `Larger than ${MAX_KB} KB. Keep it at ${MAX_KB} KB or less.`,
};

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

function parseJson(
  text: string,
): { ok: true; data: unknown } | { ok: false; issue: DocumentIssue } {
  try {
    return { ok: true, data: JSON.parse(text) };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "parse error";
    return { ok: false, issue: { severity: "error", message: `Not valid JSON: ${reason}` } };
  }
}

function zodPath(path: readonly (string | number)[]): string | undefined {
  if (path.length === 0) return undefined;
  return path
    .map((part, index) => (typeof part === "number" ? `[${part}]` : index ? `.${part}` : part))
    .join("");
}

function entryPath(index: number | null, field: string | undefined): string | undefined {
  if (index === null) return field;
  return field ? `[${index}].${field}` : `[${index}]`;
}

function structuralIssues(name: UserDocumentName, data: unknown): DocumentIssue[] | null {
  const result =
    name === "settings"
      ? UserSettingsDocument.safeParse(data)
      : KeybindingsDocument.safeParse(data);
  if (result.success) return null;
  return result.error.issues.map((issue) => {
    const path = zodPath(issue.path);
    return { severity: "error" as const, message: issue.message, ...(path ? { path } : {}) };
  });
}

/** `accepted`: the hub takes the text, so a bad entry is saved and then ignored. */
function featureIssues(
  name: UserDocumentName,
  text: string,
  data: unknown,
  accepted: boolean,
): DocumentIssue[] {
  if (name === "settings") return validateSettingsDocument(data).issues;
  return parseKeybindingsDocument(text).issues.map((issue) => {
    const path = entryPath(issue.index, issue.field);
    const message =
      accepted && issue.severity === "error" && issue.index !== null
        ? `${issue.message}. This entry is ignored.`
        : issue.message;
    return { severity: issue.severity, message, ...(path ? { path } : {}) };
  });
}

function countOf(data: unknown): number {
  if (Array.isArray(data)) return data.length;
  if (data && typeof data === "object") return Object.keys(data).length;
  return 0;
}

export function checkUserDocument(name: UserDocumentName, text: string): DocumentCheck {
  if (byteLength(text) > USER_DOCUMENT_MAX_BYTES) {
    return { valid: false, count: 0, issues: [TOO_LARGE] };
  }
  const parsed = parseJson(text);
  if (!parsed.ok) return { valid: false, count: 0, issues: [parsed.issue] };
  const { data } = parsed;
  const structural = structuralIssues(name, data);
  const feature = featureIssues(name, text, data, structural === null);
  // Feature issues say more. The structural ones show only when the feature
  // check found no error, so a refused text always says why.
  const issues =
    structural && !feature.some((issue) => issue.severity === "error")
      ? [...structural, ...feature]
      : feature;
  return { valid: structural === null, count: countOf(data), issues };
}

/** Which document a text looks like: an object is settings, an array keybindings. */
export function detectDocumentName(text: string): UserDocumentName | null {
  const parsed = parseJson(text);
  if (!parsed.ok) return null;
  if (Array.isArray(parsed.data)) return "keybindings";
  if (parsed.data && typeof parsed.data === "object") return "settings";
  return null;
}

export interface ImportCandidate {
  fileName: string;
  /** Null when the file is not a document this import takes. */
  name: UserDocumentName | null;
  /** The document the file holds when the import takes only the other one. */
  other?: UserDocumentName;
  text: string;
  check: DocumentCheck;
}

const NOT_A_DOCUMENT: DocumentIssue = {
  severity: "error",
  message: "Expected a settings object or a keybindings array.",
};

const EXPECTED: Record<UserDocumentName, DocumentIssue> = {
  settings: { severity: "error", message: "Expected a settings object." },
  keybindings: { severity: "error", message: "Expected a keybindings array." },
};

/**
 * Check a picked file's text. Pure, so it runs in tests without a File.
 *
 * `only` limits the import to one document. A file holding the other one is
 * refused without a check, and `other` says what it holds.
 */
export function importCandidate(
  fileName: string,
  text: string,
  only?: UserDocumentName,
): ImportCandidate {
  const name = detectDocumentName(text);
  if (name && only && name !== only) {
    return {
      fileName,
      name: null,
      other: name,
      text,
      check: { valid: false, count: 0, issues: [] },
    };
  }
  if (name) return { fileName, name, text, check: checkUserDocument(name, text) };
  // Broken JSON reports the parser's reason. Valid JSON of another shape
  // reports what was expected.
  const parsed = parseJson(text);
  const issue = parsed.ok ? (only ? EXPECTED[only] : NOT_A_DOCUMENT) : parsed.issue;
  return { fileName, name: null, text, check: { valid: false, count: 0, issues: [issue] } };
}

/** Read a picked file. A file over the hub's limit is not read at all. */
export async function readImportFile(
  file: Pick<File, "name" | "size" | "text">,
  only?: UserDocumentName,
): Promise<ImportCandidate> {
  if (file.size > USER_DOCUMENT_MAX_BYTES) {
    return {
      fileName: file.name,
      name: null,
      text: "",
      check: { valid: false, count: 0, issues: [TOO_LARGE] },
    };
  }
  return importCandidate(file.name, await file.text(), only);
}

const NOUNS: Record<UserDocumentName, { one: string; other: string }> = {
  settings: { one: "setting", other: "settings" },
  keybindings: { one: "entry", other: "entries" },
};

function countText(name: UserDocumentName, count: number): string {
  const noun = NOUNS[name];
  return count === 1 ? `1 ${noun.one}` : `${count} ${noun.other}`;
}

/** Where the page takes a file the limited import refused. */
const OTHER_FILE: Record<UserDocumentName, string> = {
  settings:
    "This is a settings file. Import it in Settings files below, or choose a keybindings file.",
  keybindings:
    "This is a keybindings file. Import it in Keyboard shortcuts, or choose a settings file.",
};

/** Title and description of the import dialog. `only` as given to `importCandidate`. */
export function importMessage(
  candidate: ImportCandidate,
  only?: UserDocumentName,
): { title: string; description: string } {
  const { name, check, fileName, other } = candidate;
  if (!name || !check.valid) {
    let reason: string;
    if (other) reason = OTHER_FILE[other];
    else if (!name) {
      reason = only
        ? `Choose a ${only} file exported from this page.`
        : "Choose a settings or keybindings file exported from this page.";
    }
    // The right kind of file with a broken entry. Another file is not the fix.
    else reason = "Fix the problems below, then import the file again.";
    return { title: `Unable to import ${fileName}`, description: `${reason} Nothing was changed.` };
  }
  const found = `${fileName} has ${countText(name, check.count)}.`;
  return name === "settings"
    ? {
        title: "Import settings?",
        description: `${found} It replaces your synced settings on every browser. Settings marked This device stay as they are.`,
      }
    : {
        title: "Import keybindings?",
        description: `${found} It replaces your keybindings on every browser.`,
      };
}
