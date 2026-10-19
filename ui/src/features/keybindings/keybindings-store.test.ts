import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { chordKey, parseChord } from "./chord";
import {
  applyKeybindingsText,
  parseKeybindingsDocument,
  readKeybindingsText,
  useKeybindingsStore,
} from "./keybindings-store";

describe("parseKeybindingsDocument", () => {
  it("reads an empty document as no entries", () => {
    expect(parseKeybindingsDocument("")).toEqual({ entries: [], issues: [] });
    expect(parseKeybindingsDocument("  \n")).toEqual({ entries: [], issues: [] });
    expect(parseKeybindingsDocument("[]")).toEqual({ entries: [], issues: [] });
  });

  it("reports text that is not a JSON array", () => {
    const broken = parseKeybindingsDocument("[{");
    expect(broken.entries).toEqual([]);
    expect(broken.issues[0]).toMatchObject({ index: null, severity: "error" });
    expect(broken.issues[0]?.message).toMatch(/Not valid JSON/);
    expect(parseKeybindingsDocument("{}").issues[0]?.message).toMatch(/JSON array/);
  });

  it("keeps valid entries in order with their fields", () => {
    const text = JSON.stringify([
      { key: "ctrl+shift+b", command: "sidebar.toggle" },
      { key: "ctrl+b", command: "-sidebar.toggle" },
      { mac: "cmd+j", command: "palette.open", args: { mode: "terminals" }, scope: "app" },
    ]);
    expect(parseKeybindingsDocument(text)).toEqual({
      entries: [
        { key: "ctrl+shift+b", command: "sidebar.toggle" },
        { key: "ctrl+b", command: "-sidebar.toggle" },
        { mac: "cmd+j", command: "palette.open", args: { mode: "terminals" }, scope: "app" },
      ],
      issues: [],
    });
  });

  it("drops bad entries with an error on the field", () => {
    const text = JSON.stringify([
      "ctrl+k",
      { command: "sidebar.toggle" },
      { key: "ctrl + k", command: "sidebar.toggle" },
      { mac: "cmd+shift", command: "sidebar.toggle" },
      { key: 5, command: "sidebar.toggle" },
      { key: "ctrl+k", command: "Sidebar" },
      { key: "ctrl+k", command: "sidebar.toggle", scope: "editor" },
      { key: "ctrl+k", command: "sidebar.toggle", when: "terminalFocus" },
      { key: "ctrl+k", command: "sidebar.toggle" },
    ]);
    const { entries, issues } = parseKeybindingsDocument(text);
    expect(entries).toEqual([{ key: "ctrl+k", command: "sidebar.toggle" }]);
    expect(issues.map((issue) => [issue.index, issue.field, issue.severity])).toEqual([
      [0, undefined, "error"],
      [1, "key", "error"],
      [2, "key", "error"],
      [3, "mac", "error"],
      [4, "key", "error"],
      [5, "command", "error"],
      [6, "scope", "error"],
      [7, "when", "error"],
    ]);
  });

  it("keeps args of any JSON type, as the hub does", () => {
    const args = [null, [1, "two", true], "text", 3, false, { mode: "files" }];
    const { entries, issues } = parseKeybindingsDocument(
      JSON.stringify(args.map((value) => ({ key: "escape", command: "views.close", args: value }))),
    );
    expect(issues).toEqual([]);
    expect(entries.map((entry) => entry.args)).toEqual(args);
  });

  it("drops no entry of the hub's valid fixture", () => {
    const text = fs.readFileSync(
      new URL("../../protocol/fixtures/http/user-keybindings.json", import.meta.url),
      "utf8",
    );
    const { entries, issues } = parseKeybindingsDocument(text);
    expect(issues.filter((issue) => issue.severity === "error")).toEqual([]);
    expect(entries).toHaveLength((JSON.parse(text) as unknown[]).length);
  });

  it("keeps unknown commands with a warning", () => {
    const { entries, issues } = parseKeybindingsDocument(
      JSON.stringify([{ key: "ctrl+j", command: "future.command" }]),
    );
    expect(entries).toEqual([{ key: "ctrl+j", command: "future.command" }]);
    expect(issues).toEqual([
      {
        index: 0,
        field: "command",
        message: "Unknown command future.command",
        severity: "warning",
      },
    ]);
  });

  it("caps the document at 512 entries", () => {
    const many = Array.from({ length: 513 }, () => ({ key: "ctrl+j", command: "palette.files" }));
    const { entries, issues } = parseKeybindingsDocument(JSON.stringify(many));
    expect(entries).toHaveLength(512);
    expect(issues[0]).toMatchObject({ index: null, severity: "error" });
  });
});

describe("useKeybindingsStore", () => {
  it("starts with defaults only and resolves user entries", () => {
    const store = useKeybindingsStore.getState();
    expect(store.userEntries).toEqual([]);
    expect(store.issues).toEqual([]);
    const platform = store.platform;
    const parsed = parseChord("mod+j", platform);
    if (!parsed.ok) throw new Error(parsed.error);

    const { entries, issues } = parseKeybindingsDocument(
      JSON.stringify([
        { key: "mod+j", command: "palette.files" },
        { key: "ctrl+j", command: "nope.command" },
      ]),
    );
    store.setUserEntries(entries, issues);
    const next = useKeybindingsStore.getState();
    expect(next.userEntries).toEqual(entries);
    expect(next.issues).toHaveLength(1);
    expect(next.keymap.lookup.get(chordKey(parsed.chord))?.[0]?.command).toBe("palette.files");
    expect(next.keymap.unknownCommands).toEqual(["nope.command"]);

    next.setUserEntries([]);
    expect(
      useKeybindingsStore.getState().keymap.lookup.get(chordKey(parsed.chord)),
    ).toBeUndefined();
    expect(useKeybindingsStore.getState().issues).toEqual([]);
  });
});

describe("readKeybindingsText", () => {
  it("passes a document the hub accepts through the app rules", () => {
    const text = JSON.stringify([
      { key: "ctrl+shift+b", command: "sidebar.toggle" },
      { key: "ctrl+j", command: "future.command" },
    ]);
    const read = readKeybindingsText(text);
    expect(read.valid).toBe(true);
    expect(read.entries).toEqual([
      { key: "ctrl+shift+b", command: "sidebar.toggle" },
      { key: "ctrl+j", command: "future.command" },
    ]);
    expect(read.issues.map((issue) => [issue.index, issue.severity])).toEqual([[1, "warning"]]);
  });

  it("keeps good entries of a file the hub schema refuses, one issue per entry", () => {
    const text = JSON.stringify([
      { key: "ctrl+shift+b", command: "sidebar.toggle" },
      { key: "ctrl + k", command: "palette.files" },
      { key: "ctrl+k", command: "palette.files", when: "terminalFocus" },
    ]);
    const read = readKeybindingsText(text);
    expect(read.valid).toBe(true);
    expect(read.entries).toEqual([{ key: "ctrl+shift+b", command: "sidebar.toggle" }]);
    expect(read.issues.map((issue) => [issue.index, issue.field, issue.severity])).toEqual([
      [1, "key", "error"],
      [2, "when", "error"],
    ]);
  });

  it("marks text that is not a JSON array as invalid", () => {
    expect(readKeybindingsText("[{").valid).toBe(false);
    expect(readKeybindingsText("{}").valid).toBe(false);
    expect(readKeybindingsText("{}").issues).toHaveLength(1);
    expect(readKeybindingsText("").valid).toBe(true);
    expect(readKeybindingsText("[]")).toEqual({ entries: [], issues: [], valid: true });
  });
});

describe("applyKeybindingsText", () => {
  it("sets entries and issues, and keeps entries when the text breaks", () => {
    const text = JSON.stringify([
      { key: "ctrl+shift+b", command: "sidebar.toggle" },
      { key: "ctrl+j", command: "future.command" },
    ]);
    expect(applyKeybindingsText(text)).toHaveLength(1);
    const applied = useKeybindingsStore.getState();
    expect(applied.userEntries).toHaveLength(2);
    expect(applied.issues).toHaveLength(1);

    const broken = applyKeybindingsText("[{");
    expect(broken[0]).toMatchObject({ index: null, severity: "error" });
    const after = useKeybindingsStore.getState();
    expect(after.userEntries).toBe(applied.userEntries);
    expect(after.issues).toBe(broken);

    applyKeybindingsText("[]");
    expect(useKeybindingsStore.getState().userEntries).toEqual([]);
  });
});
