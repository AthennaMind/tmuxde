import { describe, expect, it } from "vitest";
import {
  changeTouchesDiff,
  changeTouchesFile,
  changeTouchesFolder,
  relativeTo,
  sameRoot,
  trimSlash,
  type RepoChange,
} from "./repo-change";

function change(paths: string[], extra: Partial<RepoChange> = {}): RepoChange {
  return {
    seq: 1,
    root: "/w/repo",
    git: false,
    refs: false,
    paths,
    truncated: false,
    ...extra,
  };
}

describe("relativeTo", () => {
  it("maps paths under the root", () => {
    expect(relativeTo("/w/repo", "/w/repo")).toBe("");
    expect(relativeTo("/w/repo/", "/w/repo/")).toBe("");
    expect(relativeTo("/w/repo", "/w/repo/src/a.ts")).toBe("src/a.ts");
    expect(relativeTo("/", "/etc/hosts")).toBe("etc/hosts");
  });

  it("refuses paths outside the root, also a shared prefix", () => {
    expect(relativeTo("/w/repo", "/w/repo2/a")).toBeNull();
    expect(relativeTo("/w/repo", "/w")).toBeNull();
  });

  it("keeps the file system root", () => {
    expect(trimSlash("/")).toBe("/");
    expect(trimSlash("/a//")).toBe("/a");
  });
});

describe("changeTouchesFolder", () => {
  it("matches an entry right in the folder", () => {
    expect(changeTouchesFolder(change(["README.md"]), "/w/repo")).toBe(true);
    expect(changeTouchesFolder(change(["src/a.ts"]), "/w/repo/src")).toBe(true);
  });

  it("matches the folder itself", () => {
    expect(changeTouchesFolder(change(["src"]), "/w/repo/src")).toBe(true);
    // A new folder also reloads its parent.
    expect(changeTouchesFolder(change(["src"]), "/w/repo")).toBe(true);
  });

  it("leaves folders above and beside a deep change alone", () => {
    const deep = change(["src/lib/a.ts"]);
    expect(changeTouchesFolder(deep, "/w/repo")).toBe(false);
    expect(changeTouchesFolder(deep, "/w/repo/src")).toBe(false);
    expect(changeTouchesFolder(deep, "/w/repo/docs")).toBe(false);
    expect(changeTouchesFolder(deep, "/w/repo/src/lib")).toBe(true);
  });

  it("treats a truncated change as touching every folder in the root", () => {
    const cut = change([], { truncated: true });
    expect(changeTouchesFolder(cut, "/w/repo/any/where")).toBe(true);
    expect(changeTouchesFolder(cut, "/w/other")).toBe(false);
  });

  it("ignores a Git only change", () => {
    expect(changeTouchesFolder(change([], { git: true }), "/w/repo")).toBe(false);
  });
});

describe("changeTouchesFile", () => {
  it("matches the file by its path under the root", () => {
    expect(changeTouchesFile(change(["src/a.ts"]), "/w/repo/src/a.ts")).toBe(true);
    expect(changeTouchesFile(change(["src/a.ts"]), "/w/repo/src/b.ts")).toBe(false);
  });

  it("matches anything in the root when truncated", () => {
    const cut = change([], { truncated: true });
    expect(changeTouchesFile(cut, "/w/repo/x")).toBe(true);
    expect(changeTouchesFile(cut, "/w/elsewhere/x")).toBe(false);
    expect(changeTouchesFile(cut, "/w/repo")).toBe(false);
  });
});

describe("changeTouchesDiff", () => {
  it("follows the file path", () => {
    expect(changeTouchesDiff(change(["a.ts"]), "/w/repo/", "a.ts", false)).toBe(true);
    expect(changeTouchesDiff(change(["b.ts"]), "/w/repo", "a.ts", false)).toBe(false);
  });

  it("follows Git only for diffs that read the index or HEAD", () => {
    const git = change([], { git: true });
    expect(changeTouchesDiff(git, "/w/repo", "a.ts", true)).toBe(true);
    expect(changeTouchesDiff(git, "/w/repo", "a.ts", false)).toBe(false);
  });

  it("needs the same repository", () => {
    expect(changeTouchesDiff(change(["a.ts"]), "/w/other", "a.ts", true)).toBe(false);
    expect(sameRoot(change([]), "/w/repo/")).toBe(true);
  });
});
