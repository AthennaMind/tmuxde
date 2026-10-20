import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SettingsFilesList, SettingsFilesSection } from "./settings-files-section";
import { settingsCount } from "./settings-schema";

/** Visible labels of the buttons, in order. */
function buttons(markup: string): string[] {
  return [...markup.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map((match) => match[1] ?? "");
}

describe("SettingsFilesSection", () => {
  it("exports both files, imports one and resets settings", () => {
    const markup = renderToStaticMarkup(
      createElement(SettingsFilesList, { text: '{"files.wrapLines": true}' }),
    );
    expect(buttons(markup)).toEqual([
      "Export settings",
      "Reset settings",
      "Keyboard shortcuts",
      "Export keybindings",
      "Import",
    ]);
    expect(markup).not.toContain("Edit");
    expect(markup).toContain(">Keyboard shortcuts</button> has the same buttons and Reset all.");
    expect(markup.match(/type="file"/g)).toHaveLength(1);
  });

  it("hides Reset while settings hold no values", () => {
    const markup = renderToStaticMarkup(createElement(SettingsFilesSection));
    expect(markup).toContain(">Export settings</button>");
    expect(markup).not.toContain(">Reset settings</button>");
  });

  it("offers Reset for a broken file", () => {
    const markup = renderToStaticMarkup(createElement(SettingsFilesList, { text: "{" }));
    expect(markup).toContain(">Reset settings</button>");
  });
});

describe("settingsCount", () => {
  it("counts keys of an object and rejects anything else", () => {
    expect(settingsCount("{}")).toBe(0);
    expect(settingsCount('{"a.b": 1, "c.d": 2}')).toBe(2);
    expect(settingsCount("[]")).toBeNull();
    expect(settingsCount("null")).toBeNull();
    expect(settingsCount("{")).toBeNull();
  });
});
