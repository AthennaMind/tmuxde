import { afterEach, describe, expect, it } from "vitest";
import {
  draftAfterSave,
  hasUnsavedDraft,
  nextDraft,
  setJsonDraft,
  useJsonDraftsStore,
} from "./settings-json-drafts";
import { resetUserDocumentsForTests } from "./user-documents-store";

afterEach(() => {
  useJsonDraftsStore.setState({ drafts: {} });
  resetUserDocumentsForTests();
});

describe("JSON drafts", () => {
  it("starts from the server text and keeps that base while typing", () => {
    const first = nextDraft(undefined, '{"a.b": 1}', "{}");
    expect(first).toEqual({ text: '{"a.b": 1}', base: "{}" });
    const second = nextDraft(first!, '{"a.b": 2}', '{"x.y": 1}');
    expect(second).toEqual({ text: '{"a.b": 2}', base: "{}" });
  });

  it("drops a draft that matches the server text again", () => {
    expect(nextDraft({ text: "[1]", base: "[]" }, "[]", "[]")).toBeNull();
  });

  it("rebases a draft that had caught up with the server", () => {
    // The draft equals the server text, so it was clean. A new edit starts
    // from that text, not from the old base.
    expect(nextDraft({ text: "[1]", base: "[]" }, "[1, 2]", "[1]")).toEqual({
      text: "[1, 2]",
      base: "[1]",
    });
  });

  it("keeps text typed during a save on top of the saved text", () => {
    expect(draftAfterSave({ text: "[1]", base: "[]" }, "[1]")).toBeNull();
    expect(draftAfterSave({ text: "[1, 2]", base: "[]" }, "[1]")).toEqual({
      text: "[1, 2]",
      base: "[1]",
    });
    expect(draftAfterSave(undefined, "[1]")).toBeNull();
  });

  it("counts a draft as unsaved only when it differs from the server text", () => {
    expect(hasUnsavedDraft("settings")).toBe(false);
    setJsonDraft("settings", { text: '{"a.b": 1}', base: "{}" });
    expect(hasUnsavedDraft("settings")).toBe(true);
    expect(hasUnsavedDraft("keybindings")).toBe(false);
    setJsonDraft("settings", { text: "{}", base: "{}" });
    expect(hasUnsavedDraft("settings")).toBe(false);
    setJsonDraft("settings", null);
    expect(useJsonDraftsStore.getState().drafts).toEqual({});
  });
});
