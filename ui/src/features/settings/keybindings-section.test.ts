import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DEFAULT_KEYBINDINGS } from "@/features/keybindings/default-keybindings";
import { parseKeybindingsDocument } from "@/features/keybindings/keybindings-store";
import { resolveKeymap } from "@/features/keybindings/keymap";
import { KeyboardShortcutsList, KeyboardShortcutsSection } from "./keybindings-section";

const USER_TEXT = JSON.stringify([
  { key: "ctrl+b", command: "-sidebar.toggle" },
  { key: "ctrl+shift+b", command: "sidebar.toggle", scope: "app" },
]);

function keymapOf(text: string) {
  return resolveKeymap(DEFAULT_KEYBINDINGS, parseKeybindingsDocument(text).entries, "other");
}

/** The section for a fixed keymap: Linux defaults plus the document. */
function render(touch: boolean, text = USER_TEXT): string {
  return renderToStaticMarkup(
    createElement(KeyboardShortcutsList, { keymap: keymapOf(text), text, touch }),
  );
}

/** Markup of one command's row, found by its title. */
function row(markup: string, title: string): string {
  const found = markup
    .split('<li class="px-4 py-2.5">')
    .find((chunk) => chunk.includes(`>${title}</span>`));
  expect(found, title).toBeDefined();
  return found ?? "";
}

/** Visible labels of the row's buttons, in order. */
function buttons(markup: string): string[] {
  return [...markup.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map((match) => match[1] ?? "");
}

describe("KeyboardShortcutsSection", () => {
  it("lists commands by group with chords and scopes", () => {
    const markup = render(false);
    expect(markup).toContain("Keyboard shortcuts");
    expect(markup).toContain('data-settings-section="keyboard-shortcuts"');
    for (const group of ["Palette", "Workspace", "Terminal", "Security"]) {
      expect(markup).toContain(`>${group}</h3>`);
    }
    // tmux keys belong to the user's tmux config.
    expect(markup).not.toContain(">tmux</h3>");
    expect(markup).not.toContain(">Split pane right</span>");
    expect(markup).not.toContain(">Send tmux prefix</span>");
    const palette = row(markup, "Command palette");
    expect(palette).toContain("Ctrl K");
    expect(palette).toContain("Control K");
    expect(palette).toContain("Global");
    expect(palette).toContain('aria-label="Change shortcut for Command palette"');
    expect(palette).toContain('aria-label="Remove shortcut for Command palette"');
    // Not changed by the user, so nothing to reset.
    expect(palette).not.toContain("Reset Command palette");
    expect(buttons(palette)).toEqual(["Change", "Remove"]);
  });

  it("shows the user's binding in place of the removed default, with Reset", () => {
    const sidebar = row(render(false), "Toggle sidebar");
    expect(sidebar).toContain("Ctrl Shift B");
    expect(sidebar).not.toContain(">Ctrl B<");
    expect(sidebar).toContain("Outside terminal");
    expect(sidebar).toContain('aria-label="Reset Toggle sidebar to its default shortcut"');
    expect(buttons(sidebar)).toEqual(["Change", "Remove", "Reset"]);
  });

  it("offers Add for a command without a shortcut, and Reset all", () => {
    const markup = render(false);
    const closeAll = row(markup, "Close all views");
    expect(closeAll).toContain("No shortcut");
    expect(closeAll).toContain('aria-label="Add shortcut for Close all views"');
    expect(buttons(closeAll)).toEqual(["Add"]);
    expect(markup).toContain(">Reset all</button>");
  });

  it("offers Remove and Reset for the one command a document binds", () => {
    const text = JSON.stringify([
      { key: "ctrl+alt+n", command: "views.closeAll", scope: "global" },
    ]);
    const markup = render(false, text);
    const closeAll = row(markup, "Close all views");
    expect(closeAll).toContain("Ctrl Alt N");
    expect(closeAll).toContain('aria-label="Change shortcut for Close all views"');
    expect(closeAll).toContain('aria-label="Remove shortcut for Close all views"');
    // No default, so Reset takes it back to no shortcut.
    expect(closeAll).toContain('aria-label="Reset Close all views to no shortcut"');
    expect(buttons(closeAll)).toEqual(["Change", "Remove", "Reset"]);
    for (const title of ["Open settings", "Light theme"]) {
      const unbound = row(markup, title);
      expect(unbound).toContain(`aria-label="Add shortcut for ${title}"`);
      expect(buttons(unbound)).toEqual(["Add"]);
    }
  });

  it("names the chord Remove takes off when a command has several", () => {
    const zoom = row(render(false, "[]"), "Larger text, terminal or open file");
    expect(zoom).toContain("Ctrl =");
    expect(zoom).toContain("Ctrl Shift =");
    expect(zoom).toContain(
      'aria-label="Remove Control Equals from Larger text, terminal or open file"',
    );
    const removed = row(
      render(false, JSON.stringify([{ key: "ctrl+=", command: "-terminal.zoomIn" }])),
      "Larger text, terminal or open file",
    );
    expect(removed).toContain(
      'aria-label="Reset Larger text, terminal or open file to its default shortcuts"',
    );
  });

  it("puts the file actions next to Reset all in the header", () => {
    const markup = render(false);
    const header = markup.slice(0, markup.indexOf("</h3>"));
    expect(buttons(header)).toEqual(["Export", "Import", "Reset all"]);
    expect(header).not.toContain("Edit JSON");
    expect(header).toContain('aria-label="Export keybindings"');
    expect(header).toContain('aria-label="Import keybindings"');
    expect(header).toContain('accept="application/json,.json"');
  });

  it("renders from the stores with the defaults", () => {
    const markup = renderToStaticMarkup(createElement(KeyboardShortcutsSection, { touch: false }));
    expect(row(markup, "Toggle sidebar")).toContain("Outside terminal");
    expect(markup).not.toContain(">Reset all</button>");
    expect(markup).toContain(">Export</button>");
  });

  it("keeps Remove and Reset on touch, without recording", () => {
    const markup = render(true);
    expect(markup).toContain("Recording a shortcut needs a keyboard.");
    expect(markup).toContain("Ctrl K");
    expect(markup).not.toContain("No shortcut");
    expect(markup).not.toContain("Change shortcut for");
    expect(markup).not.toContain("Add shortcut for");
    expect(buttons(row(markup, "Command palette"))).toEqual(["Remove"]);
    expect(buttons(row(markup, "Toggle sidebar"))).toEqual(["Remove", "Reset"]);
    expect(markup).toContain(">Reset all</button>");
    expect(markup).toContain(">Import</button>");
  });

  it("keeps a removed default on touch so Reset can bring it back", () => {
    const markup = render(true, JSON.stringify([{ key: "ctrl+b", command: "-sidebar.toggle" }]));
    const sidebar = row(markup, "Toggle sidebar");
    expect(sidebar).toContain("No shortcut");
    expect(buttons(sidebar)).toEqual(["Reset"]);
    expect(markup).not.toContain(">New window</span>");
  });
});
