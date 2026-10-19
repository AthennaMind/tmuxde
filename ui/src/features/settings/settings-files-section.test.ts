import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SettingsFilesSection } from "./settings-files-section";

describe("SettingsFilesSection", () => {
  it("keeps both files, one import and a link to the shortcuts", () => {
    const markup = renderToStaticMarkup(createElement(SettingsFilesSection));
    for (const label of [
      "Edit settings JSON",
      "Export settings",
      "Edit keybindings JSON",
      "Export keybindings",
      "Import",
    ]) {
      expect(markup).toContain(`>${label}</button>`);
    }
    expect(markup).toContain(">Keyboard shortcuts</button> has the same buttons.");
    expect(markup.match(/type="file"/g)).toHaveLength(1);
  });
});
