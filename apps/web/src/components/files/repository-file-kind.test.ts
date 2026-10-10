import { describe, expect, it } from "vitest";
import { repositoryFileKind } from "./repository-file-kind";

describe("repository file icons", () => {
  it.each([
    ["src/main.TSX", "react"],
    ["src/main.ts", "code"],
    ["src/main.py", "code"],
    ["script.sh", "shell"],
    ["package.json", "package"],
    ["pnpm-lock.yaml", "package"],
    ["config.json", "json"],
    [".env.local", "config"],
    ["settings.toml", "config"],
    ["Dockerfile.dev", "container"],
    ["compose.yaml", "container"],
    [".gitignore", "git"],
    ["README.md", "readme"],
    ["notes.md", "document"],
    ["photo.HEIC", "image"],
    ["sound.mp3", "audio"],
    ["clip.mov", "video"],
    ["backup.tar.gz", "archive"],
    ["state.sqlite3", "database"],
    ["query.sql", "database"],
    ["data.csv", "table"],
    ["font.woff2", "font"],
    ["styles.css", "style"],
    ["unknown.xyz", "file"],
    ["constructor", "file"],
    ["__proto__", "file"],
  ])("classifies %s as %s", (path, kind) => {
    expect(repositoryFileKind(path)).toBe(kind);
  });

  it("uses basename rather than parent directory names", () => {
    expect(repositoryFileKind("Dockerfile/src/code.json")).toBe("json");
    expect(repositoryFileKind("image.png/README")).toBe("readme");
  });
});
