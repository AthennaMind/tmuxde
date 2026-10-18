import { describe, expect, it } from "vitest";
import {
  addSeenIndices,
  commitSections,
  compileFilePattern,
  fileExtension,
  fileExtensions,
  filesChanged,
  filterCommitFiles,
  hasExtensionPattern,
  parseFilePatterns,
  patternGlob,
  sameSectionProps,
  toggleExtensionPattern,
} from "./commit-file-filter";

const file = (path: string, originalPath?: string) => ({ path, originalPath });

const FILES = [
  file("README.md"),
  file("docs/guide.md"),
  file("docs/api/index.MD"),
  file("scripts/setup.sh"),
  file("ui/src/app.tsx"),
  file("Makefile"),
  file(".gitignore"),
  file("dist/app.tar.gz"),
];

function paths(text: string, mode: "hide" | "only") {
  return filterCommitFiles(FILES, {
    patterns: parseFilePatterns(text),
    mode,
  }).map((entry) => entry.file.path);
}

describe("parseFilePatterns", () => {
  it("splits on commas and whitespace", () => {
    expect(parseFilePatterns(" *.md, docs/**  sh,,\tjs\n")).toEqual([
      "*.md",
      "docs/**",
      "sh",
      "js",
    ]);
  });

  it("drops empties and duplicates and keeps order", () => {
    expect(parseFilePatterns("sh, md, sh , ,md")).toEqual(["sh", "md"]);
    expect(parseFilePatterns("  , ")).toEqual([]);
  });
});

describe("patternGlob", () => {
  it("reads bare extensions as *.ext", () => {
    expect(patternGlob("md")).toBe("*.md");
    expect(patternGlob(".md")).toBe("*.md");
    expect(patternGlob(".tar.gz")).toBe("*.tar.gz");
  });

  it("keeps globs, paths and file names as typed", () => {
    expect(patternGlob("*.md")).toBe("*.md");
    expect(patternGlob("docs/")).toBe("docs/");
    expect(patternGlob("README.md")).toBe("README.md");
    expect(patternGlob("a?c")).toBe("a?c");
  });
});

describe("compileFilePattern", () => {
  it("matches the file name when the pattern has no slash", () => {
    const md = compileFilePattern("*.md");
    expect(md("README.md")).toBe(true);
    expect(md("docs/deep/guide.md")).toBe(true);
    expect(md("docs/guide.mdx")).toBe(false);
    expect(md("md.txt")).toBe(false);
  });

  it("matches the full path when the pattern has a slash", () => {
    expect(compileFilePattern("docs/*.md")("docs/guide.md")).toBe(true);
    expect(compileFilePattern("/docs/*.md")("docs/guide.md")).toBe(true);
    expect(compileFilePattern("docs/*.md")("other/docs/guide.md")).toBe(false);
  });

  it("keeps * in one segment and lets ** cross segments", () => {
    expect(compileFilePattern("docs/*.md")("docs/api/index.md")).toBe(false);
    expect(compileFilePattern("docs/**.md")("docs/api/index.md")).toBe(true);
    expect(compileFilePattern("docs/**")("docs/api/index.md")).toBe(true);
    expect(compileFilePattern("docs/**/index.md")("docs/index.md")).toBe(true);
    expect(compileFilePattern("docs/**/index.md")("docs/a/b/index.md")).toBe(true);
    expect(compileFilePattern("**/api/*")("docs/api/index.md")).toBe(true);
  });

  it("reads a trailing slash as the whole folder", () => {
    expect(compileFilePattern("docs/")("docs/api/index.md")).toBe(true);
    expect(compileFilePattern("docs/")("docsx/a.md")).toBe(false);
  });

  it("matches one character with ?", () => {
    expect(compileFilePattern("a?c.ts")("abc.ts")).toBe(true);
    expect(compileFilePattern("a?c.ts")("ac.ts")).toBe(false);
    expect(compileFilePattern("x?y")("x/y")).toBe(false);
  });

  it("escapes RegExp characters", () => {
    expect(compileFilePattern("a+b(1).ts")("a+b(1).ts")).toBe(true);
    expect(compileFilePattern("a.ts")("abts")).toBe(false);
    expect(compileFilePattern("[x].ts")("[x].ts")).toBe(true);
  });

  it("ignores case", () => {
    expect(compileFilePattern("md")("docs/api/index.MD")).toBe(true);
    expect(compileFilePattern("DOCS/**")("docs/a.md")).toBe(true);
    expect(compileFilePattern("readme.md")("README.md")).toBe(true);
  });

  it("lets a bare word match a file of that exact name", () => {
    expect(compileFilePattern("Makefile")("Makefile")).toBe(true);
    expect(compileFilePattern("makefile")("build/Makefile")).toBe(true);
    expect(compileFilePattern(".md")("md")).toBe(false);
  });

  it("matches dot files and multi part extensions", () => {
    expect(compileFilePattern("gitignore")(".gitignore")).toBe(true);
    expect(compileFilePattern(".tar.gz")("dist/app.tar.gz")).toBe(true);
    expect(compileFilePattern("gz")("dist/app.tar.gz")).toBe(true);
  });
});

describe("filterCommitFiles", () => {
  it("keeps every file for empty patterns, in both modes", () => {
    expect(paths("", "hide")).toEqual(FILES.map((f) => f.path));
    expect(paths(" , ", "only")).toEqual(FILES.map((f) => f.path));
  });

  it("hides matching files", () => {
    expect(paths("md", "hide")).toEqual([
      "scripts/setup.sh",
      "ui/src/app.tsx",
      "Makefile",
      ".gitignore",
      "dist/app.tar.gz",
    ]);
  });

  it("keeps only matching files", () => {
    expect(paths(".sh", "only")).toEqual(["scripts/setup.sh"]);
    expect(paths("sh, docs/**", "only")).toEqual([
      "docs/guide.md",
      "docs/api/index.MD",
      "scripts/setup.sh",
    ]);
  });

  it("returns the original index of each file", () => {
    const visible = filterCommitFiles(FILES, {
      patterns: ["sh", "tsx"],
      mode: "only",
    });
    expect(visible.map(({ index }) => index)).toEqual([3, 4]);
    expect(visible[0]?.file).toBe(FILES[3]);
  });

  it("matches a rename by its new or old path", () => {
    const renamed = [file("docs/new.txt", "notes/old.md"), file("a.ts")];
    const only = (patterns: string[]) =>
      filterCommitFiles(renamed, { patterns, mode: "only" }).map(({ index }) => index);
    expect(only(["md"])).toEqual([0]);
    expect(only(["txt"])).toEqual([0]);
    expect(only(["notes/"])).toEqual([0]);
    expect(
      filterCommitFiles(renamed, { patterns: ["md"], mode: "hide" }).map(({ index }) => index),
    ).toEqual([1]);
  });

  it("treats a null original path as no rename", () => {
    const files = [{ path: "a.md", originalPath: null }];
    expect(filterCommitFiles(files, { patterns: ["md"], mode: "hide" })).toEqual([]);
  });
});

describe("fileExtensions", () => {
  it("reads the text after the last dot of the name", () => {
    expect(fileExtension("dist/app.tar.gz")).toBe("gz");
    expect(fileExtension("docs/api/index.MD")).toBe("md");
    expect(fileExtension("v1.2/Makefile")).toBeUndefined();
    expect(fileExtension(".gitignore")).toBeUndefined();
    expect(fileExtension("trailing.")).toBeUndefined();
  });

  it("counts extensions and sorts by count then name", () => {
    expect(fileExtensions([...FILES, file("a.sh"), file("b.ts"), file("c.ts")])).toEqual([
      { ext: "md", count: 3 },
      { ext: "sh", count: 2 },
      { ext: "ts", count: 2 },
      { ext: "gz", count: 1 },
      { ext: "tsx", count: 1 },
    ]);
  });

  it("returns nothing for files without extensions", () => {
    expect(fileExtensions([file("Makefile"), file(".env")])).toEqual([]);
  });
});

describe("extension chips", () => {
  it("sees any spelling of the extension in the text", () => {
    expect(hasExtensionPattern("md", "md")).toBe(true);
    expect(hasExtensionPattern("docs/**, .MD", "md")).toBe(true);
    expect(hasExtensionPattern("*.md", "md")).toBe(true);
    expect(hasExtensionPattern("*.mdx, README.md", "md")).toBe(false);
  });

  it("adds the extension as *.ext", () => {
    expect(toggleExtensionPattern("", "md")).toBe("*.md");
    expect(toggleExtensionPattern("docs/** sh", "md")).toBe("docs/**, sh, *.md");
  });

  it("removes every spelling of the extension", () => {
    expect(toggleExtensionPattern("md, docs/**, .md, *.MD", "md")).toBe("docs/**");
    expect(toggleExtensionPattern("*.md", "md")).toBe("");
  });
});

describe("diff sections", () => {
  const files = ["a.md", "b.ts", "c.md", "d.sh"].map((path) => file(path));
  const pick = (mode: "hide" | "only", text: string) =>
    filterCommitFiles(files, { patterns: parseFilePatterns(text), mode });
  const shape = (sections: ReturnType<typeof commitSections>) =>
    sections.map(({ index, hidden }) => [index, hidden]);

  it("renders only visible files before any were seen", () => {
    expect(shape(commitSections(files, pick("hide", "md"), new Set()))).toEqual([
      [1, false],
      [3, false],
    ]);
  });

  it("keeps seen files mounted and hidden while the filter drops them", () => {
    // Opened with no filter, then `md` typed in Hide.
    const seen = addSeenIndices(new Set(), pick("hide", ""));
    expect(shape(commitSections(files, pick("hide", "md"), seen))).toEqual([
      [0, true],
      [1, false],
      [2, true],
      [3, false],
    ]);
  });

  it("keeps commit order when a filter brings files back", () => {
    const seen = addSeenIndices(new Set(), pick("only", "sh"));
    expect(shape(commitSections(files, pick("only", "md, sh"), seen))).toEqual([
      [0, false],
      [2, false],
      [3, false],
    ]);
  });

  it("returns the same set when nothing new is visible", () => {
    const seen = addSeenIndices(new Set(), pick("hide", ""));
    expect(addSeenIndices(seen, pick("only", "md"))).toBe(seen);
    const grown = addSeenIndices(new Set([0]), pick("only", "md"));
    expect([...grown].sort()).toEqual([0, 2]);
  });
});

describe("sameSectionProps", () => {
  const onToggle = () => {};
  const props = (hidden: boolean, wrap: boolean) => ({
    index: 0,
    hidden,
    open: true,
    wrap,
    onToggle,
  });

  it("skips a section that stays hidden, even when wrap changes", () => {
    expect(sameSectionProps(props(true, false), props(true, true))).toBe(true);
  });

  it("renders a shown section when wrap changes", () => {
    expect(sameSectionProps(props(false, false), props(false, true))).toBe(false);
    expect(sameSectionProps(props(false, true), props(false, true))).toBe(true);
  });

  it("renders when the filter hides or shows the section", () => {
    // Showing again picks up the wrap set while it was hidden.
    expect(sameSectionProps(props(true, false), props(false, true))).toBe(false);
    expect(sameSectionProps(props(false, false), props(true, false))).toBe(false);
  });

  it("compares every prop by identity", () => {
    expect(
      sameSectionProps(props(false, false), {
        ...props(false, false),
        onToggle: () => {},
      }),
    ).toBe(false);
  });
});

describe("filesChanged", () => {
  it("counts the whole commit without a filter", () => {
    expect(filesChanged(3, 3, false)).toBe("3 files changed");
    expect(filesChanged(1, 1, false)).toBe("1 file changed");
  });

  it("names the full count while a filter hides files", () => {
    expect(filesChanged(2, 3, true)).toBe("2 of 3 files changed");
    expect(filesChanged(0, 1, true)).toBe("0 of 1 file changed");
    expect(filesChanged(3, 3, true)).toBe("3 of 3 files changed");
  });
});
