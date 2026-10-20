import { describe, expect, it } from "vitest";
import { getFileCategory, getFileViewMode, previewLimit } from "./file-utils";

describe("file view modes", () => {
  it.each([
    ["/clips/holiday.MP4", "video"],
    ["talk.mkv", "video"],
    ["clip.webm", "video"],
    ["voice.opus", "audio"],
    ["song.m4a", "audio"],
    ["paper.pdf", "pdf"],
    ["Inter.woff2", "font"],
    ["Mono.ttf", "font"],
    ["photo.avif", "image"],
    ["icon.svg", "image"],
    ["scan.tiff", "binary"],
    ["archive.tar.gz", "binary"],
    ["report.docx", "binary"],
    ["app.wasm", "binary"],
    ["notes.txt", "text"],
    ["main.go", "text"],
    ["/home/u.name/Makefile", "text"],
    [".png", "text"],
    ["", "text"],
  ])("%s opens as %s", (path, mode) => {
    expect(getFileViewMode(path)).toBe(mode);
  });

  it("names a category for the download card", () => {
    expect(getFileCategory("x.zip")).toBe("archive");
    expect(getFileCategory("x.sqlite")).toBe("database");
    expect(getFileCategory("x.pdf")).toBe("document");
    expect(getFileCategory("x.md")).toBeNull();
    expect(getFileCategory("/a.b/README")).toBeNull();
  });

  it("limits blob previews only", () => {
    expect(previewLimit("image")).toBe(10 * 1024 * 1024);
    expect(previewLimit("font")).toBe(10 * 1024 * 1024);
    expect(previewLimit("video")).toBe(0);
    expect(previewLimit("pdf")).toBe(0);
    expect(previewLimit("text")).toBe(0);
  });
});
