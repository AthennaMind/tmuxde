import { describe, expect, expectTypeOf, it } from "vitest";
import {
  SETTINGS,
  SETTINGS_KEYS,
  diffFromDefaults,
  parseSettingsText,
  resolveSettings,
  settingDefault,
  settingsJsonSchema,
  validateSettingsDocument,
  type Settings,
} from "./settings-schema";
import { defaultToolbarKeys } from "./settings-store";
import { getDefaultFontSize } from "@/features/terminal/terminal-store";

describe("settings registry", () => {
  it("holds the keys of the plan", () => {
    expect(SETTINGS_KEYS).toHaveLength(25);
    expect(SETTINGS_KEYS.filter((key) => SETTINGS[key].scope === "device").sort()).toEqual([
      "editor.zoom",
      "terminal.fontSize",
      "terminal.gpuRendering",
    ]);
  });

  it("gives every key a section, label and description", () => {
    for (const key of SETTINGS_KEYS) {
      expect(SETTINGS[key].section, key).toBeTruthy();
      expect(SETTINGS[key].label, key).toBeTruthy();
      expect(SETTINGS[key].description, key).toBeTruthy();
    }
  });

  it("types values by key", () => {
    expectTypeOf<Settings["appearance.theme"]>().toEqualTypeOf<"light" | "dark" | "system">();
    expectTypeOf<Settings["terminal.fontWeight"]>().toEqualTypeOf<400 | 500 | 600 | 700>();
    expectTypeOf<Settings["touch.toolbarKeys"]>().toEqualTypeOf<string[]>();
    expectTypeOf<Settings["terminal.cursorBlink"]>().toEqualTypeOf<boolean>();
  });

  it("takes the font size default from the device", () => {
    expect(settingDefault("terminal.fontSize")).toBe(getDefaultFontSize());
  });

  it("defaults the toolbar to the visible default keys", () => {
    expect(settingDefault("touch.toolbarKeys")).toEqual(
      defaultToolbarKeys.filter((key) => key.visible).map((key) => key.id),
    );
  });
});

describe("resolveSettings", () => {
  it("gives every default for an empty document", () => {
    const settings = resolveSettings({});
    for (const key of SETTINGS_KEYS) expect(settings[key], key).toEqual(settingDefault(key));
  });

  it("takes valid document values and ignores wrong types", () => {
    const settings = resolveSettings({
      "terminal.cursorBlink": false,
      "terminal.scrollback": "lots",
      "terminal.fontWeight": 650,
      "appearance.theme": "light",
    });
    expect(settings["terminal.cursorBlink"]).toBe(false);
    expect(settings["terminal.scrollback"]).toBe(5000);
    expect(settings["terminal.fontWeight"]).toBe(600);
    expect(settings["appearance.theme"]).toBe("light");
  });

  it("lets device values win for device keys only", () => {
    const settings = resolveSettings(
      { "terminal.fontSize": 18, "terminal.cursorStyle": "bar" },
      { "terminal.fontSize": 12, "terminal.cursorStyle": "underline", "editor.zoom": 9 },
    );
    expect(settings["terminal.fontSize"]).toBe(12);
    // Device overrides never reach a user key.
    expect(settings["terminal.cursorStyle"]).toBe("bar");
    // Out of range device value falls through to the default.
    expect(settings["editor.zoom"]).toBe(1);
  });

  it("falls back to the document for a device key this browser never set", () => {
    expect(resolveSettings({ "terminal.fontSize": 18 }, {})["terminal.fontSize"]).toBe(18);
  });

  it("keeps toolbar ids in toolbar order and drops unknown ones", () => {
    const settings = resolveSettings({ "touch.toolbarKeys": ["at", "removed", "tab", "at"] });
    expect(settings["touch.toolbarKeys"]).toEqual(["tab", "at"]);
  });
});

describe("diffFromDefaults", () => {
  it("is empty for defaults", () => {
    expect(diffFromDefaults(resolveSettings({}))).toEqual({});
  });

  it("round trips through resolveSettings", () => {
    const document = {
      "appearance.theme": "system",
      "terminal.theme": "nord",
      "terminal.fontWeight": 500,
      "changes.filterPatterns": "*.md",
      "changes.filterMode": "only",
      "touch.gesture.pinchToZoom": false,
      "touch.toolbarKeys": ["tab", "esc", "at"],
    };
    const settings = resolveSettings(document);
    expect(diffFromDefaults(settings)).toEqual(document);
    expect(resolveSettings(diffFromDefaults(settings))).toEqual(settings);
  });

  it("leaves device keys out", () => {
    const settings = { ...resolveSettings({}), "terminal.fontSize": 20, "editor.zoom": 1.5 };
    expect(diffFromDefaults(settings)).toEqual({});
  });
});

describe("validateSettingsDocument", () => {
  it("keeps unknown keys and warns about them", () => {
    const input = { "terminal.cursorBlink": false, "future.thing": 3 };
    const { document, issues } = validateSettingsDocument(input);
    expect(document).toEqual(input);
    expect(issues).toEqual([
      expect.objectContaining({ severity: "warning", path: "future.thing" }),
    ]);
  });

  it("reports wrong types as errors that resolve ignores", () => {
    const { document, issues } = validateSettingsDocument({
      "terminal.scrollback": 50,
      "appearance.theme": "blue",
    });
    expect(issues.map((issue) => [issue.path, issue.severity])).toEqual([
      ["terminal.scrollback", "error"],
      ["appearance.theme", "error"],
    ]);
    expect(resolveSettings(document)["terminal.scrollback"]).toBe(5000);
    expect(resolveSettings(document)["appearance.theme"]).toBe("dark");
  });

  it("rejects keys the server would refuse", () => {
    const { issues } = validateSettingsDocument({ Terminal: 1, "a..b": 2 });
    expect(issues.every((issue) => issue.severity === "error")).toBe(true);
    expect(issues).toHaveLength(2);
  });

  it("warns that a device key in the document is only a fallback", () => {
    const { issues } = validateSettingsDocument({ "terminal.fontSize": 16 });
    expect(issues).toEqual([
      expect.objectContaining({ severity: "warning", path: "terminal.fontSize" }),
    ]);
  });

  it("refuses anything but an object", () => {
    for (const input of [[], null, 3, "x"]) {
      const { document, issues } = validateSettingsDocument(input);
      expect(document).toEqual({});
      expect(issues[0]?.severity).toBe("error");
    }
  });

  it("parses text and reports broken JSON", () => {
    expect(parseSettingsText('{"files.wrapLines": true}')).toMatchObject({
      document: { "files.wrapLines": true },
      issues: [],
      valid: true,
    });
    const broken = parseSettingsText("{");
    expect(broken.valid).toBe(false);
    expect(broken.issues[0]?.message).toMatch(/^Invalid JSON/);
  });
});

describe("settingsJsonSchema", () => {
  const schema = settingsJsonSchema() as {
    type: string;
    properties: Record<string, Record<string, unknown>>;
    propertyNames: { pattern: string };
  };

  it("describes user keys with enums, ranges and descriptions", () => {
    expect(schema.type).toBe("object");
    expect(schema.properties["appearance.theme"]).toMatchObject({
      enum: ["light", "dark", "system"],
      default: "dark",
    });
    expect(schema.properties["terminal.scrollback"]).toMatchObject({
      type: "integer",
      minimum: 100,
      maximum: 100000,
    });
    expect(schema.properties["terminal.fontWeight"]?.enum).toEqual([400, 500, 600, 700]);
    for (const property of Object.values(schema.properties)) {
      expect(typeof property.description).toBe("string");
    }
  });

  it("leaves device keys to the settings page", () => {
    expect(Object.keys(schema.properties)).not.toContain("terminal.fontSize");
    expect(Object.keys(schema.properties)).not.toContain("editor.zoom");
    expect(Object.keys(schema.properties)).toHaveLength(22);
  });

  it("is plain JSON", () => {
    expect(JSON.parse(JSON.stringify(schema))).toEqual(schema);
    expect(new RegExp(schema.propertyNames.pattern).test("terminal.fontSize")).toBe(true);
  });
});
