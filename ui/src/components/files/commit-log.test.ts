import { describe, expect, it } from "vitest";
import type { RepoCommit } from "@repo/protocol";
import {
  FirstPageGate,
  commitAge,
  keepOlderPages,
  parseRefs,
} from "./commit-log";

const commit = (hash: string): RepoCommit => ({
  hash,
  parents: [],
  author: "t",
  date: "2026-10-14T10:00:00Z",
  subject: hash,
  refs: [],
});
const list = (...hashes: string[]) => hashes.map(commit);
const hashes = (commits: RepoCommit[] | null) =>
  commits?.map((c) => c.hash) ?? null;

describe("parseRefs", () => {
  it("marks the current branch and tags, and drops remote HEAD", () => {
    expect(
      parseRefs(["HEAD -> main", "origin/main", "origin/HEAD", "tag: v1.2"]),
    ).toEqual([
      { name: "main", kind: "head" },
      { name: "origin/main", kind: "branch" },
      { name: "v1.2", kind: "tag" },
    ]);
  });

  it("keeps a detached HEAD", () => {
    expect(parseRefs(["HEAD"])).toEqual([{ name: "HEAD", kind: "head" }]);
  });
});

describe("commitAge", () => {
  const now = Date.parse("2026-10-11T12:00:00Z");
  const ago = (seconds: number) => new Date(now - seconds * 1000).toISOString();

  it("counts minutes, hours and days", () => {
    expect(commitAge(ago(30), now)).toBe("now");
    expect(commitAge(ago(5 * 60), now)).toBe("5m");
    expect(commitAge(ago(3 * 3600), now)).toBe("3h");
    expect(commitAge(ago(4 * 86_400), now)).toBe("4d");
  });

  it("switches to a date after a month", () => {
    expect(commitAge(ago(60 * 86_400), now)).not.toMatch(/d$/);
    expect(commitAge("2024-03-04T10:00:00Z", now)).toMatch(/2024/);
  });

  it("answers nothing for a bad date", () => {
    expect(commitAge("not a date", now)).toBe("");
  });
});

describe("keepOlderPages", () => {
  // Pages of 4 for short lists. The old list loaded two pages.
  const loaded = list("a", "b", "c", "d", "e", "f", "g", "h");

  it("keeps older pages when the first page did not move", () => {
    const next = list("a", "b", "c", "d");
    next[0] = { ...next[0]!, refs: ["HEAD -> main"] };
    const kept = keepOlderPages(loaded, next);
    expect(hashes(kept)).toEqual(["a", "b", "c", "d", "e", "f", "g", "h"]);
    // The first page carries the new decorations.
    expect(kept![0]!.refs).toEqual(["HEAD -> main"]);
  });

  it("keeps older pages below new commits on top", () => {
    expect(hashes(keepOlderPages(loaded, list("n", "a", "b", "c")))).toEqual([
      "n", "a", "b", "c", "d", "e", "f", "g", "h",
    ]);
    expect(hashes(keepOlderPages(loaded, list("n", "m", "a", "b")))).toEqual([
      "n", "m", "a", "b", "c", "d", "e", "f", "g", "h",
    ]);
  });

  it("starts over when the history changed in another way", () => {
    // The old first commit is gone, as after an amend.
    expect(keepOlderPages(loaded, list("z", "b", "c", "d"))).toBeNull();
    // A commit came in below the old first one.
    expect(keepOlderPages(loaded, list("n", "a", "x", "b"))).toBeNull();
    // Nothing was loaded past the new page.
    expect(keepOlderPages(list("a", "b"), list("n", "a", "b"))).toBeNull();
    expect(keepOlderPages([], list("a"))).toBeNull();
  });

  it("never repeats a commit", () => {
    // A tip moved up from an older page.
    const kept = keepOlderPages(loaded, list("f", "a", "b", "c"));
    expect(hashes(kept)).toEqual(["f", "a", "b", "c", "d", "e", "g", "h"]);
  });
});

describe("FirstPageGate", () => {
  it("sends one request at a time and one more for asks meanwhile", () => {
    const gate = new FirstPageGate();
    expect(gate.take(true)).toBe(false);
    gate.mark();
    expect(gate.take(true)).toBe(true);
    // Ten pushes while the request is in flight send nothing now.
    for (let i = 0; i < 10; i++) {
      gate.mark();
      expect(gate.take(true)).toBe(false);
    }
    // The answer lets exactly one more go.
    gate.settle();
    expect(gate.take(true)).toBe(true);
    gate.settle();
    expect(gate.take(true)).toBe(false);
  });

  it("holds asks while hidden and sends one when shown", () => {
    const gate = new FirstPageGate();
    for (let i = 0; i < 5; i++) {
      gate.mark();
      expect(gate.take(false)).toBe(false);
    }
    expect(gate.take(true)).toBe(true);
    gate.settle();
    // Staying in front with nothing new asks nothing.
    expect(gate.take(true)).toBe(false);
  });

  it("asks once when a hidden list is shown again", () => {
    const gate = new FirstPageGate();
    gate.mark();
    expect(gate.take(true)).toBe(true);
    gate.settle();
    // A hidden list holds no watch, so nothing marks it while away.
    expect(gate.take(false)).toBe(false);
    expect(gate.take(false)).toBe(false);
    expect(gate.take(true)).toBe(true);
    gate.settle();
    expect(gate.take(true)).toBe(false);
  });

  it("waits for the request in flight when shown again", () => {
    const gate = new FirstPageGate();
    gate.mark();
    expect(gate.take(true)).toBe(true);
    // Hidden and shown again while the first page loads.
    expect(gate.take(false)).toBe(false);
    expect(gate.take(true)).toBe(false);
    gate.settle();
    expect(gate.take(true)).toBe(true);
    gate.settle();
    expect(gate.take(true)).toBe(false);
  });
});
