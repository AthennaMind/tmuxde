import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { ServerMessage } from "./server-messages";
import {
  KeybindingsDocument,
  USER_DOCUMENT_EMPTY,
  USER_DOCUMENT_MAX_ENTRIES,
  USER_DOCUMENT_NAMES,
  UserSettingsDocument,
  isKeybindingChord,
  userDocumentPath,
} from "./user-documents";

// Shared HTTP fixtures. The Go contract test in internal/hub/settings reads
// the same files and must agree entry by entry.
const readFixture = (name: string): unknown =>
  JSON.parse(fs.readFileSync(new URL(`./fixtures/http/${name}`, import.meta.url), "utf8"));

type InvalidEntry = { reason: string; document: unknown };

const readInvalid = (name: string): InvalidEntry[] => {
  const entries = readFixture(name);
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error(`${name} must be a non empty array`);
  }
  return entries as InvalidEntry[];
};

const documents = [
  {
    name: "settings",
    schema: UserSettingsDocument,
    valid: "user-settings.json",
    invalid: "user-settings.invalid.json",
  },
  {
    name: "keybindings",
    schema: KeybindingsDocument,
    valid: "user-keybindings.json",
    invalid: "user-keybindings.invalid.json",
  },
] as const;

describe.each(documents)("$name document", ({ name, schema, valid, invalid }) => {
  it("parses the shared fixture without dropping anything", () => {
    const fixture = readFixture(valid);
    expect(schema.parse(fixture)).toEqual(fixture);
  });

  it("parses the empty value the hub serves for a missing file", () => {
    expect(schema.safeParse(JSON.parse(USER_DOCUMENT_EMPTY[name])).success).toBe(true);
  });

  const entries = readInvalid(invalid);
  it.each(entries.map((entry) => [entry.reason, entry] as const))("rejects %s", (_, entry) => {
    expect(Object.keys(entry).sort()).toEqual(["document", "reason"]);
    expect(schema.safeParse(entry.document).success).toBe(false);
  });
});

describe("document limits", () => {
  it("accepts 512 settings keys and rejects 513", () => {
    const doc = (count: number) =>
      Object.fromEntries(Array.from({ length: count }, (_, i) => [`test.key${i}`, i]));
    expect(UserSettingsDocument.safeParse(doc(USER_DOCUMENT_MAX_ENTRIES)).success).toBe(true);
    expect(UserSettingsDocument.safeParse(doc(USER_DOCUMENT_MAX_ENTRIES + 1)).success).toBe(false);
  });

  it("accepts 512 bindings and rejects 513", () => {
    const doc = (count: number) =>
      Array.from({ length: count }, () => ({ key: "ctrl+b", command: "sidebar.toggle" }));
    expect(KeybindingsDocument.safeParse(doc(USER_DOCUMENT_MAX_ENTRIES)).success).toBe(true);
    expect(KeybindingsDocument.safeParse(doc(USER_DOCUMENT_MAX_ENTRIES + 1)).success).toBe(false);
  });
});

describe("chord grammar", () => {
  it.each([
    "a",
    "z",
    "0",
    "f1",
    "f12",
    "shift+/",
    "ctrl+\\",
    "mod+k",
    "ctrl+shift+space",
    "cmd+shift+=",
    "alt+meta+super+win+pagedown",
  ])("accepts %s", (chord) => {
    expect(isKeybindingChord(chord)).toBe(true);
  });

  it.each([
    "",
    "+",
    "ctrl+",
    "+a",
    "ctrl++",
    "ctrl+ctrl+a",
    "a+ctrl",
    "ctrl+shift",
    "Ctrl+a",
    "ctrl+A",
    "ctrl a",
    "f0",
    "f13",
    "plus",
  ])("rejects %j", (chord) => {
    expect(isKeybindingChord(chord)).toBe(false);
  });
});

describe("settings:changed", () => {
  it("names only user documents", () => {
    for (const name of USER_DOCUMENT_NAMES) {
      const message = { type: "settings:changed", name, etag: '"abc"' };
      expect(ServerMessage.parse(message)).toEqual(message);
    }
    expect(
      ServerMessage.safeParse({ type: "settings:changed", name: "theme", etag: '"abc"' }).success,
    ).toBe(false);
  });

  it("builds the hub path of a document", () => {
    expect(USER_DOCUMENT_NAMES.map(userDocumentPath)).toEqual([
      "/user/settings",
      "/user/keybindings",
    ]);
  });
});
