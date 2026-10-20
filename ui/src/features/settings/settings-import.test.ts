import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { USER_DOCUMENT_MAX_BYTES } from "@/protocol";
import {
  checkUserDocument,
  detectDocumentName,
  importCandidate,
  importMessage,
  readImportFile,
} from "./settings-import";

// The hub's own fixtures. What the hub accepts must check as valid here,
// and what it refuses must not.
const fixture = (name: string): unknown =>
  JSON.parse(
    fs.readFileSync(new URL(`../../protocol/fixtures/http/${name}`, import.meta.url), "utf8"),
  );

const invalid = (name: string) => fixture(name) as { reason: string; document: unknown }[];

describe("checkUserDocument", () => {
  it("accepts the hub fixtures and counts their entries", () => {
    const settings = fixture("user-settings.json") as Record<string, unknown>;
    const keybindings = fixture("user-keybindings.json") as unknown[];
    const settingsCheck = checkUserDocument("settings", JSON.stringify(settings));
    expect(settingsCheck).toMatchObject({ valid: true, count: Object.keys(settings).length });
    const keybindingsCheck = checkUserDocument("keybindings", JSON.stringify(keybindings));
    expect(keybindingsCheck).toMatchObject({ valid: true, count: keybindings.length });
    // No entry the hub keeps is ignored here. Only unknown commands warn.
    expect(keybindingsCheck.issues.filter((issue) => issue.severity === "error")).toEqual([]);
  });

  it.each(invalid("user-settings.invalid.json").map((entry) => [entry.reason, entry] as const))(
    "refuses settings: %s",
    (_, entry) => {
      const check = checkUserDocument("settings", JSON.stringify(entry.document));
      expect(check.valid).toBe(false);
      expect(check.issues.some((issue) => issue.severity === "error")).toBe(true);
    },
  );

  it.each(invalid("user-keybindings.invalid.json").map((entry) => [entry.reason, entry] as const))(
    "refuses keybindings: %s",
    (_, entry) => {
      const check = checkUserDocument("keybindings", JSON.stringify(entry.document));
      expect(check.valid).toBe(false);
      expect(check.issues.some((issue) => issue.severity === "error")).toBe(true);
    },
  );

  it("reports broken JSON with the parser's reason", () => {
    const check = checkUserDocument("settings", '{"terminal.theme": ');
    expect(check).toMatchObject({ valid: false, count: 0 });
    expect(check.issues[0]?.message).toMatch(/^Not valid JSON/);
  });

  it("keeps a wrong value valid and says the default applies", () => {
    const check = checkUserDocument("settings", JSON.stringify({ "terminal.fontWeight": 450 }));
    expect(check.valid).toBe(true);
    expect(check.issues).toEqual([
      expect.objectContaining({ severity: "error", path: "terminal.fontWeight" }),
    ]);
    expect(check.issues[0]?.message).toMatch(/default applies/);
  });

  it("warns on unknown commands with the entry path", () => {
    const check = checkUserDocument(
      "keybindings",
      JSON.stringify([{ key: "ctrl+j", command: "future.command" }]),
    );
    expect(check.valid).toBe(true);
    expect(check.issues).toEqual([
      { severity: "warning", path: "[0].command", message: "Unknown command future.command" },
    ]);
  });

  it("takes what the hub takes and says why the hub refuses the rest", () => {
    // Any JSON args and two names for one modifier pass on both sides.
    const accepted = checkUserDocument(
      "keybindings",
      JSON.stringify([
        { key: "ctrl+k", command: "lock.now", args: 3 },
        { key: "mod+ctrl+j", command: "views.close", args: null },
      ]),
    );
    expect(accepted).toEqual({ valid: true, count: 2, issues: [] });
    // The hub refuses this one, so the whole file is not saved.
    const refused = checkUserDocument(
      "keybindings",
      JSON.stringify([{ key: "ctrl+plus", command: "lock.now" }]),
    );
    expect(refused.valid).toBe(false);
    expect(refused.issues[0]?.message).not.toMatch(/ignored/);
  });

  it("refuses text over the hub's body limit", () => {
    const text = JSON.stringify({ "x.y": "a".repeat(USER_DOCUMENT_MAX_BYTES) });
    const check = checkUserDocument("settings", text);
    expect(check.valid).toBe(false);
    expect(check.issues[0]?.message).toMatch(/256 KB/);
  });
});

describe("import", () => {
  it("tells the documents apart by shape", () => {
    expect(detectDocumentName("{}")).toBe("settings");
    expect(detectDocumentName("[]")).toBe("keybindings");
    expect(detectDocumentName("null")).toBeNull();
    expect(detectDocumentName("1")).toBeNull();
    expect(detectDocumentName("{")).toBeNull();
  });

  it("builds a candidate with the file name and the check", () => {
    const text = JSON.stringify([{ key: "ctrl+shift+b", command: "sidebar.toggle" }]);
    expect(importCandidate("tmuxde-keybindings.json", text)).toEqual({
      fileName: "tmuxde-keybindings.json",
      name: "keybindings",
      text,
      check: { valid: true, count: 1, issues: [] },
    });
  });

  it("explains a file that is neither document", () => {
    const other = importCandidate("notes.json", '"text"');
    expect(other).toMatchObject({ name: null, check: { valid: false, count: 0 } });
    expect(other.check.issues[0]?.message).toMatch(/settings object or a keybindings array/);
    const broken = importCandidate("broken.json", "[{");
    expect(broken.check.issues[0]?.message).toMatch(/^Not valid JSON/);
  });

  it("does not read a file over the limit", async () => {
    let read = false;
    const big = await readImportFile({
      name: "big.json",
      size: USER_DOCUMENT_MAX_BYTES + 1,
      text: async () => {
        read = true;
        return "{}";
      },
    });
    expect(read).toBe(false);
    expect(big).toMatchObject({ name: null, check: { valid: false } });
    const small = await readImportFile({ name: "s.json", size: 2, text: async () => "{}" });
    expect(small).toMatchObject({ name: "settings", check: { valid: true, count: 0 } });
  });
});

describe("import limited to keybindings", () => {
  const KEYBINDINGS = JSON.stringify([{ key: "ctrl+shift+b", command: "sidebar.toggle" }]);

  it("refuses a settings file and says where it goes", () => {
    const candidate = importCandidate("tmuxde-settings.json", "{}", "keybindings");
    expect(candidate).toEqual({
      fileName: "tmuxde-settings.json",
      name: null,
      other: "settings",
      text: "{}",
      check: { valid: false, count: 0, issues: [] },
    });
    expect(importMessage(candidate, "keybindings")).toEqual({
      title: "Unable to import tmuxde-settings.json",
      description:
        "This is a settings file. Import it in Settings files below, or choose a keybindings file. Nothing was changed.",
    });
  });

  it("refuses a settings file read from disk", async () => {
    const candidate = await readImportFile(
      { name: "s.json", size: 2, text: async () => "{}" },
      "keybindings",
    );
    expect(candidate).toMatchObject({ name: null, other: "settings", check: { valid: false } });
  });

  it("asks for a keybindings file when the file is neither", () => {
    const other = importCandidate("notes.json", '"text"', "keybindings");
    expect(other.other).toBeUndefined();
    expect(other.check.issues).toEqual([
      { severity: "error", message: "Expected a keybindings array." },
    ]);
    expect(importMessage(other, "keybindings").description).toBe(
      "Choose a keybindings file exported from this page. Nothing was changed.",
    );
  });

  it("takes a keybindings file as without the limit", () => {
    const candidate = importCandidate("tmuxde-keybindings.json", KEYBINDINGS, "keybindings");
    expect(candidate).toEqual(importCandidate("tmuxde-keybindings.json", KEYBINDINGS));
    expect(importMessage(candidate, "keybindings")).toEqual({
      title: "Import keybindings?",
      description:
        "tmuxde-keybindings.json has 1 entry. It replaces your keybindings on every browser.",
    });
  });

  it("keeps the open import for either file", () => {
    const settings = importCandidate("tmuxde-settings.json", "{}");
    expect(settings).toMatchObject({ name: "settings", check: { valid: true } });
    expect(importMessage(settings).title).toBe("Import settings?");
    expect(importMessage(importCandidate("notes.json", "1")).description).toBe(
      "Choose a settings or keybindings file exported from this page. Nothing was changed.",
    );
  });
});
