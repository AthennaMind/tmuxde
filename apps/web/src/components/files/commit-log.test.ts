import { describe, expect, it } from "vitest";
import { commitAge, parseRefs } from "./commit-log";

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
