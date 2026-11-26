import { expect, it, vi } from "vitest";
import { findOpenHunk } from "./file-hunk";
import { fileHunks } from "./file-diff";

it("anchors removed blocks to surviving lines, including the first and last gaps", () => {
  expect(fileHunks("first\nkeep\nlast\n", "keep\n")).toEqual([
    { originalStart: 1, start: 1, end: 1, beforeFirst: true, removed: "first\n", added: "" },
    { originalStart: 3, start: 1, end: 1, beforeFirst: false, removed: "last\n", added: "" },
  ]);
});

it("keeps replacements together and shifts later markers into buffer coordinates", () => {
  expect(fileHunks("old\nkeep\nlast\n", "new\nsecond\nkeep\nlast\nextra")).toEqual([
    {
      originalStart: 1,
      start: 1,
      end: 2,
      beforeFirst: false,
      removed: "old\n",
      added: "new\nsecond\n",
    },
    { originalStart: 4, start: 5, end: 5, beforeFirst: false, removed: "", added: "extra" },
  ]);
});

it("marks new text and keeps final newline changes distinct from CRLF", () => {
  expect(fileHunks("", "one\n\n")[0]).toMatchObject({ start: 1, end: 2, added: "one\n\n" });
  expect(fileHunks("one\r\n", "one\n")).toEqual([]);
  expect(fileHunks("one\n", "one")[0]).toMatchObject({ removed: "one\n", added: "one" });
});

it("keeps the changed span visible when detailed comparison times out", () => {
  let time = 0;
  const clock = vi.spyOn(Date, "now").mockImplementation(() => (time += 1000));
  try {
    expect(fileHunks("top\rold\rmiddle\rold\rend\r", "top\rnew\rmiddle\rnew\rend\r")).toEqual([
      {
        originalStart: 2,
        start: 2,
        end: 4,
        beforeFirst: false,
        removed: "old\nmiddle\nold\n",
        added: "new\nmiddle\nnew\n",
      },
    ]);
  } finally {
    clock.mockRestore();
  }
});

it("uses Monaco line numbers for CR and mixed line endings", () => {
  expect(fileHunks("a\rb\rc\r", "a\rB\r\nc\n")).toMatchObject([
    { start: 2, end: 2, removed: "b\n", added: "B\n" },
  ]);
});

it("keeps an expanded hunk when edits shift, merge or split its lines", () => {
  const base = "one\ntwo\nthree\nfour\n";
  const single = fileHunks(base, "one\nTWO\nthree\nfour\n")[0]!;
  const shifted = fileHunks(base, "new\none\nTWO!\nthree\nfour\n");
  expect(findOpenHunk(shifted, single, 3)).toBe(shifted[1]);
  const merged = fileHunks(base, "one\nTWO\nTHREE\nfour\n")[0]!;
  expect(findOpenHunk([merged], single, 2)).toBe(merged);
  expect(findOpenHunk([single], merged, 2)).toBe(single);
  expect(findOpenHunk(fileHunks(base, "one\ntwo\nthree\nFOUR\n"), single, 2)).toBeUndefined();
});
