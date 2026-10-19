import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { COMMAND_IDS } from "@/features/keybindings/command-ids";
import {
  USER_DOCUMENT_SCHEMA_URIS,
  chordPattern,
  foreignSchemas,
  keybindingsJsonSchema,
  modelPattern,
  schemaAssociations,
  userDocumentJsonSchema,
} from "./user-document-schemas";

const fixture = (name: string): unknown =>
  JSON.parse(
    fs.readFileSync(new URL(`../../protocol/fixtures/http/${name}`, import.meta.url), "utf8"),
  );

describe("chordPattern", () => {
  const pattern = new RegExp(chordPattern(), "u");

  it("matches every chord of the hub's valid fixture", () => {
    const entries = fixture("user-keybindings.json") as { key?: string; mac?: string }[];
    const chords = entries.flatMap((entry) => [entry.key, entry.mac]).filter(Boolean);
    expect(chords.length).toBeGreaterThan(10);
    for (const chord of chords) expect(chord).toMatch(pattern);
  });

  it("rejects chords outside the grammar", () => {
    for (const chord of ["", "ctrl + b", "Ctrl+B", "ctrl+B", "ctrl+plus", "ctrl++", "f13", "f0"]) {
      expect(pattern.test(chord), chord).toBe(false);
    }
    for (const chord of ["ctrl+shift", "ctrl", "ctrl+k ctrl+s", "hyper+k"]) {
      expect(pattern.test(chord), chord).toBe(false);
    }
  });
});

describe("keybindingsJsonSchema", () => {
  it("offers every command and its removal", () => {
    const schema = keybindingsJsonSchema() as {
      items: { properties: { command: { enum: string[] }; scope: { enum: string[] } } };
    };
    const commands = schema.items.properties.command.enum;
    expect(commands).toHaveLength(COMMAND_IDS.length * 2);
    expect(commands).toContain("sidebar.toggle");
    expect(commands).toContain("-sidebar.toggle");
    expect(schema.items.properties.scope.enum).toEqual(["global", "app", "terminal"]);
  });

  it("picks the schema per document", () => {
    expect(userDocumentJsonSchema("keybindings")).toMatchObject({ type: "array" });
    expect(userDocumentJsonSchema("settings")).toMatchObject({ type: "object" });
  });
});

describe("schema associations", () => {
  it("matches each document's schema to its own models only", () => {
    const models = new Map([
      ["model/3", "settings" as const],
      ["model/7", "keybindings" as const],
      ["model/9", "settings" as const],
    ]);
    const associations = schemaAssociations(models);
    expect(associations.map(({ uri, fileMatch }) => ({ uri, fileMatch }))).toEqual([
      { uri: USER_DOCUMENT_SCHEMA_URIS.settings, fileMatch: ["model/3", "model/9"] },
      { uri: USER_DOCUMENT_SCHEMA_URIS.keybindings, fileMatch: ["model/7"] },
    ]);
    expect(schemaAssociations(new Map())).toEqual([]);
  });

  it("keeps schemas other code registered", () => {
    const other = { uri: "https://example.invalid/schema.json", fileMatch: ["*.json"] };
    expect(foreignSchemas([other, { uri: USER_DOCUMENT_SCHEMA_URIS.settings }])).toEqual([other]);
    expect(foreignSchemas(undefined)).toEqual([]);
  });

  it("turns a model URI into a pattern for that model", () => {
    expect(modelPattern("inmemory://model/3")).toBe("model/3");
    expect(modelPattern("file:///home/a.json")).toBe("/home/a.json");
  });
});
