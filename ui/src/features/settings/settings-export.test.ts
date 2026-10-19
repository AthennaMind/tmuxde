import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { downloadText } from "@/shared/download-text";
import { EXPORT_FILE_NAMES, exportFileName, exportUserDocument } from "./settings-export";
import { resetUserDocumentsForTests, useUserDocumentsStore } from "./user-documents-store";

/** A document and URL stand in, enough for one download. */
function stubDownload() {
  const anchor = {
    href: "",
    download: "",
    rel: "",
    style: { display: "" },
    click: vi.fn(),
    remove: vi.fn(),
  };
  const append = vi.fn();
  vi.stubGlobal("document", { createElement: vi.fn(() => anchor), body: { append } });
  const createObjectURL = vi.fn((blob: Blob) => {
    blobs.push(blob);
    return "blob:test";
  });
  const revokeObjectURL = vi.fn();
  vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });
  const blobs: Blob[] = [];
  return { anchor, append, blobs, revokeObjectURL };
}

beforeEach(() => {
  vi.useFakeTimers();
  resetUserDocumentsForTests();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("export", () => {
  it("names the files after the document", () => {
    expect(exportFileName("settings")).toBe("tmuxde-settings.json");
    expect(exportFileName("keybindings")).toBe("tmuxde-keybindings.json");
    expect(Object.keys(EXPORT_FILE_NAMES).sort()).toEqual(["keybindings", "settings"]);
  });

  it("downloads the current text exactly", async () => {
    const { anchor, append, blobs, revokeObjectURL } = stubDownload();
    const text = '[\n  { "key": "ctrl+shift+b", "command": "sidebar.toggle" }\n]\n';
    useUserDocumentsStore.setState((state) => ({
      documents: { ...state.documents, keybindings: { ...state.documents.keybindings, text } },
    }));
    exportUserDocument("keybindings");
    expect(anchor.download).toBe("tmuxde-keybindings.json");
    expect(anchor.href).toBe("blob:test");
    expect(append).toHaveBeenCalledWith(anchor);
    expect(anchor.click).toHaveBeenCalledTimes(1);
    expect(anchor.remove).toHaveBeenCalledTimes(1);
    expect(blobs[0]?.type).toBe("application/json;charset=utf-8");
    expect(await blobs[0]?.text()).toBe(text);
    // Revoked later, since some browsers read the URL after the click.
    expect(revokeObjectURL).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:test");
  });

  it("takes another type for plain text", () => {
    const { blobs } = stubDownload();
    downloadText("notes.txt", "hello", "text/plain");
    expect(blobs[0]?.type).toBe("text/plain;charset=utf-8");
  });
});
