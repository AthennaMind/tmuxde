import { describe, expect, it } from "vitest";
import { parsePatch, splitPath } from "./commit-diff";

describe("parsePatch", () => {
  it("numbers old and new lines across hunks", () => {
    const patch = [
      "diff --git a/a.ts b/a.ts",
      "index 1111111..2222222 100644",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1,3 +1,3 @@ function a()",
      " one",
      "-two",
      "+zwei",
      " three",
      "@@ -10,2 +10,3 @@",
      " ten",
      "+ten and a half",
      "\\ No newline at end of file",
    ].join("\n");
    const { meta, rows } = parsePatch(patch);
    expect(meta).toEqual([]);
    expect(rows).toEqual([
      { kind: "hunk", index: 4, text: "@@ -1,3 +1,3 @@ function a()" },
      { kind: "context", index: 5, text: " one", old: 1, new: 1 },
      { kind: "del", index: 6, text: "-two", old: 2 },
      { kind: "add", index: 7, text: "+zwei", new: 2 },
      { kind: "context", index: 8, text: " three", old: 3, new: 3 },
      { kind: "hunk", index: 9, text: "@@ -10,2 +10,3 @@" },
      { kind: "context", index: 10, text: " ten", old: 10, new: 10 },
      { kind: "add", index: 11, text: "+ten and a half", new: 11 },
      { kind: "note", index: 12, text: "\\ No newline at end of file" },
    ]);
  });

  it("keeps a mode change and drops what the file header shows", () => {
    const patch = [
      "diff --git a/run.sh b/run.sh",
      "old mode 100644",
      "new mode 100755",
    ].join("\n");
    expect(parsePatch(patch)).toEqual({
      meta: ["old mode 100644", "new mode 100755"],
      rows: [],
    });
  });

  it("treats header-like text inside a hunk as content", () => {
    const patch = ["@@ -0,0 +1,2 @@", "+--- not a header", "++++ also not"].join(
      "\n",
    );
    expect(parsePatch(patch).rows.map((row) => row.kind)).toEqual([
      "hunk",
      "add",
      "add",
    ]);
  });

  it("answers nothing for an empty patch", () => {
    expect(parsePatch("")).toEqual({ meta: [], rows: [] });
  });
});

describe("splitPath", () => {
  it("splits folder from name", () => {
    expect(splitPath("apps/web/a.ts")).toEqual({
      folder: "apps/web/",
      name: "a.ts",
    });
    expect(splitPath("README.md")).toEqual({ folder: "", name: "README.md" });
  });
});
