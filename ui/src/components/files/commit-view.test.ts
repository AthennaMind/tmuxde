import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { RepoCommitFile } from "@/protocol";
import { CommitDetail, FileChangesDetail, type CommitResult } from "./commit-view";

// A server render reads the initial store state, so the filter comes from a
// stand in store instead.
const filter = vi.hoisted(() => ({
  commitFilterPatterns: "",
  commitFilterMode: "hide" as "hide" | "only",
}));
vi.mock("@/stores/settings-store", () => ({
  useSettingsStore: (select: (state: typeof filter) => unknown) => select(filter),
}));

function commitFile(path: string): RepoCommitFile {
  return {
    path,
    status: "M",
    additions: 1,
    deletions: 0,
    binary: false,
    patch: `diff --git a/${path} b/${path}\n@@ -1 +1,2 @@\n line\n+added`,
  };
}

const RESULT: CommitResult = {
  kind: "show",
  root: "/repo",
  commit: {
    hash: "a".repeat(40),
    parents: ["b".repeat(40)],
    author: "t",
    email: "t@example.invalid",
    date: "2026-10-14T10:00:00Z",
    committer: "t",
    committerDate: "2026-10-14T10:00:00Z",
    subject: "Mixed files",
    body: "",
    refs: [],
  },
  files: ["README.md", "src/app.ts", "scripts/run.sh"].map(commitFile),
  hidden: 0,
  truncated: false,
};

function render(patterns: string, mode: "hide" | "only", wrap = false) {
  filter.commitFilterPatterns = patterns;
  filter.commitFilterMode = mode;
  return renderToStaticMarkup(
    createElement(CommitDetail, {
      result: RESULT,
      wrap,
      onOpenCommit: () => {},
    }),
  );
}

/** File names of the diff sections, from their region labels. */
function sections(markup: string): string[] {
  return [...markup.matchAll(/aria-label="Diff of ([^"]+)"/g)].map((match) => match[1] ?? "");
}

describe("CommitDetail filter", () => {
  it("renders every section without a filter", () => {
    const markup = render("", "hide");
    expect(sections(markup)).toEqual(["README.md", "src/app.ts", "scripts/run.sh"]);
    expect(markup).toContain("3 files changed");
    expect(markup).not.toContain("Clear filter");
  });

  it("mounts only matching sections when a commit opens filtered", () => {
    // Sections mount once shown. Files the filter drops on open cost nothing.
    const markup = render("md", "hide");
    expect(sections(markup)).toEqual(["src/app.ts", "scripts/run.sh"]);
    expect(markup.match(/<section aria-labelledby/g)).toHaveLength(2);
    expect(markup).toContain("2 of 3 files changed");
    expect(markup).toContain("Showing 2 of 3 files");
  });

  it("says so when nothing matches", () => {
    const markup = render("*.nothing", "only");
    expect(sections(markup)).toEqual([]);
    expect(markup).toContain("No files match this filter.");
    expect(markup).toContain("Clear filter");
  });
});

describe("CommitDetail wrap", () => {
  // Wrap lines sets classes on each diff's rows container. Rows carry no wrap
  // class, so a toggle on a big commit does not build every row again.
  it("sets wrap once per diff, not on each row", () => {
    for (const wrap of [false, true]) {
      const markup = render("", "hide", wrap);
      const codes = [...markup.matchAll(/<code class="([^"]*)"/g)];
      // Three rows per file: hunk, context and the added line.
      expect(codes).toHaveLength(9);
      for (const [, className] of codes) expect(className).not.toMatch(/whitespace|break-all/);
      const containers = markup.match(/\[&amp;_code\]:whitespace-pre-wrap/g);
      expect(containers?.length ?? 0).toBe(wrap ? 3 : 0);
      const unwrapped = markup.match(/\[&amp;_code\]:whitespace-pre"/g);
      expect(unwrapped?.length ?? 0).toBe(wrap ? 0 : 3);
    }
  });
});

describe("current changes detail", () => {
  it("shares filters and scoped diffs without commit metadata", () => {
    filter.commitFilterPatterns = "md";
    filter.commitFilterMode = "hide";
    const markup = renderToStaticMarkup(
      createElement(FileChangesDetail, {
        result: {
          files: [
            { ...commitFile("app.ts"), scope: "staged" },
            { ...commitFile("app.ts"), scope: "unstaged" },
            { ...commitFile("README.md"), scope: "untracked" },
          ],
          hidden: 0,
          truncated: false,
        },
        wrap: false,
        header: createElement("h2", {}, "Uncommitted changes"),
      }),
    );
    expect(sections(markup)).toEqual(["app.ts", "app.ts"]);
    expect(markup).toContain("staged");
    expect(markup).toContain("unstaged");
    expect(markup).toContain("1 of 2 files changed");
    expect(markup).toContain("Uncommitted changes");
    expect(markup).not.toContain("Author");
    expect(markup).not.toContain("No commit message");
  });
});
