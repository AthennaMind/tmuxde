import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { RepoCommit } from "@repo/protocol";
import { layoutGraph, type GraphRow } from "./graph-layout";
import {
  GraphCell,
  GraphList,
  MAX_LANES,
  laneX,
  sameRowProps,
} from "./graph-list";

function render(row: GraphRow, head = false) {
  return renderToStaticMarkup(
    createElement(GraphCell, { row, merge: false, head }),
  );
}

/** The x of every circle in the markup. */
function circles(html: string): number[] {
  return [...html.matchAll(/<circle[^>]*\scx="([\d.]+)"/g)].map((m) =>
    Number(m[1]),
  );
}

describe("GraphCell", () => {
  it("draws the node in its own lane", () => {
    const html = render({ lane: 2, color: 0, lanes: 3, child: true, edges: [] });
    expect(circles(html)).toEqual([laneX(2)]);
    expect(html).not.toContain("offscreen");
  });

  it("never draws a node past the cap on the last lane", () => {
    const row: GraphRow = {
      lane: 30,
      color: 1,
      lanes: 31,
      child: true,
      edges: [
        { from: 30, to: 30, color: 1, kind: "parent" },
        { from: 30, to: 5, color: 1, kind: "merge" },
        { from: 3, to: 3, color: 2, kind: "pass" },
        { from: 26, to: 26, color: 3, kind: "pass" },
      ],
    };
    const html = render(row, true);
    const xs = circles(html);
    expect(xs).not.toContain(laneX(MAX_LANES - 1));
    expect(xs).toHaveLength(1);
    expect(xs[0]!).toBeGreaterThan(MAX_LANES * 14);
    expect(html).toContain('data-node="offscreen"');
    expect(html).toContain(
      `title="Current commit. In lane 31. Only the first ${MAX_LANES} lanes are drawn."`,
    );
    // Lines that stay in hidden lanes are left out. The merge into lane 5
    // and the pass in lane 3 stay.
    expect(html).not.toContain(`M${laneX(26)} `);
    expect(html).not.toContain(`M${laneX(30)} 0V`);
    expect(html).toContain(`M${laneX(30)} 14C`);
    expect(html).toContain(`M${laneX(3)} 14V28`);
    expect(html).toMatch(/>\+(<!-- -->)?7</);
  });
});

describe("row rendering", () => {
  const commit = (hash: string, ...parents: string[]): RepoCommit => ({
    hash,
    parents,
    author: "A",
    date: "2026-10-14T10:00:00Z",
    subject: `Subject ${hash}`,
    refs: hash === "c" ? ["HEAD -> main"] : [],
  });
  const onFocus = () => {};
  const onOpen = () => {};
  const props = (commits: RepoCommit[], i: number) => ({
    commit: commits[i]!,
    row: layoutGraph(commits)[i]!,
    selected: false,
    tabStop: false,
    onFocus,
    onOpen,
  });

  it("is memoized, so a render of the tab view skips the list", () => {
    expect((GraphList as unknown as { $$typeof: symbol }).$$typeof).toBe(
      Symbol.for("react.memo"),
    );
  });

  it("skips rows that a new first page left as they were", () => {
    const page = [commit("c", "b"), commit("b", "a"), commit("a")];
    // The same page again comes back as new objects.
    const again = structuredClone(page);
    for (let i = 0; i < page.length; i++)
      expect(sameRowProps(props(page, i), props(again, i))).toBe(true);
  });

  it("renders a row again when what it shows changed", () => {
    const page = [commit("c", "b"), commit("b", "a"), commit("a")];
    const base = props(page, 1);
    const moved = [commit("d", "c"), ...page];
    // Same layout and commit in a longer page.
    expect(sameRowProps(base, props(moved, 2))).toBe(true);
    // The old top row gets a child line.
    expect(sameRowProps(props(page, 0), props(moved, 1))).toBe(false);
    expect(sameRowProps(base, { ...base, selected: true })).toBe(false);
    expect(sameRowProps(base, { ...base, tabStop: true })).toBe(false);
    expect(sameRowProps(base, { ...base, onOpen: () => {} })).toBe(false);
    expect(
      sameRowProps(base, { ...base, commit: { ...base.commit, refs: ["tag: v1"] } }),
    ).toBe(false);
    expect(
      sameRowProps(base, { ...base, commit: { ...base.commit, subject: "Other" } }),
    ).toBe(false);
  });
});
