import { describe, expect, it } from "vitest";
import {
  GRAPH_COLORS,
  graphOrder,
  layoutGraph,
  sameGraphRow,
  type GraphCommit,
} from "./graph-layout";

const c = (hash: string, ...parents: string[]): GraphCommit => ({
  hash,
  parents,
});

/** Lanes that come into each row from above, from the row itself. */
function incoming(row: ReturnType<typeof layoutGraph>[number]): number[] {
  const lanes = row.edges.filter((e) => e.from !== row.lane).map((e) => e.from);
  if (row.child) lanes.push(row.lane);
  return [...new Set(lanes)].sort((a, b) => a - b);
}

/** Lanes that leave each row at the bottom. */
function outgoing(row: ReturnType<typeof layoutGraph>[number]): number[] {
  return [...new Set(row.edges.map((e) => e.to))].sort((a, b) => a - b);
}

describe("layoutGraph", () => {
  it("keeps a linear history in one lane", () => {
    const rows = layoutGraph([c("c", "b"), c("b", "a"), c("a")]);
    expect(rows.map((r) => r.lane)).toEqual([0, 0, 0]);
    expect(rows.map((r) => r.lanes)).toEqual([1, 1, 1]);
    expect(rows.map((r) => r.child)).toEqual([false, true, true]);
    expect(rows[0]!.edges).toEqual([{ from: 0, to: 0, color: 0, kind: "parent" }]);
    expect(rows[2]!.edges).toEqual([]);
    expect(new Set(rows.map((r) => r.color))).toEqual(new Set([0]));
  });

  it("draws a branch and its merge", () => {
    // m merges s into b. s and b both come from a.
    const rows = layoutGraph([c("m", "b", "s"), c("s", "a"), c("b", "a"), c("a")]);
    expect(rows.map((r) => r.lane)).toEqual([0, 1, 0, 0]);
    expect(rows[0]!.edges).toEqual([
      { from: 0, to: 0, color: 0, kind: "parent" },
      { from: 0, to: 1, color: 1, kind: "merge" },
    ]);
    expect(rows[0]!.lanes).toBe(2);
    // s goes on to a in its own lane, b passes by.
    expect(rows[1]!.edges).toEqual([
      { from: 1, to: 1, color: 1, kind: "parent" },
      { from: 0, to: 0, color: 0, kind: "pass" },
    ]);
    // b also waits for a. The lane of s on the right joins it.
    expect(rows[2]!.edges).toEqual([
      { from: 0, to: 0, color: 0, kind: "parent" },
      { from: 1, to: 0, color: 1, kind: "merge" },
    ]);
    expect(rows[3]).toMatchObject({ lane: 0, lanes: 1, child: true, edges: [] });
  });

  it("bends a lane into an older one waiting for the same parent", () => {
    // Two tips, the right one is first in the list below its sibling.
    const rows = layoutGraph([c("x", "a"), c("y", "a"), c("a")]);
    expect(rows.map((r) => r.lane)).toEqual([0, 1, 0]);
    expect(rows[1]!.edges).toEqual([
      { from: 1, to: 0, color: 1, kind: "parent" },
      { from: 0, to: 0, color: 0, kind: "pass" },
    ]);
    expect(rows[2]!.lanes).toBe(1);
  });

  it("opens one lane per extra parent of an octopus merge", () => {
    const rows = layoutGraph([
      c("o", "a", "b", "d"),
      c("d", "r"),
      c("b", "r"),
      c("a", "r"),
      c("r"),
    ]);
    expect(rows[0]!.edges).toEqual([
      { from: 0, to: 0, color: 0, kind: "parent" },
      { from: 0, to: 1, color: 1, kind: "merge" },
      { from: 0, to: 2, color: 2, kind: "merge" },
    ]);
    expect(rows[0]!.lanes).toBe(3);
    expect(rows.map((r) => r.lane)).toEqual([0, 2, 1, 0, 0]);
    // d waits for r first. b then a find it waiting on the right and take it
    // over, so r lands in lane 0.
    expect(rows[4]).toMatchObject({ lane: 0, child: true, lanes: 1 });
  });

  it("gives two roots their own lanes", () => {
    const rows = layoutGraph([c("m", "a", "b"), c("b"), c("a")]);
    expect(rows.map((r) => r.lane)).toEqual([0, 1, 0]);
    expect(rows[1]!.edges).toEqual([{ from: 0, to: 0, color: 0, kind: "pass" }]);
    expect(rows[2]!.edges).toEqual([]);
    expect(rows[2]!.lanes).toBe(1);
  });

  it("keeps lanes open to the bottom for parents beyond the page", () => {
    const rows = layoutGraph([c("m", "p1", "p2"), c("t", "p3")]);
    expect(rows[1]!.lane).toBe(2);
    expect(rows[1]!.child).toBe(false);
    expect(outgoing(rows[1]!)).toEqual([0, 1, 2]);
    expect(rows[1]!.lanes).toBe(3);
  });

  it("treats a parent that came first like a parent beyond the page", () => {
    // Git's default order put p above both children. Their lines run to
    // the bottom in one lane, and no lane opens for p again.
    const rows = layoutGraph([c("p", "r"), c("c1", "p"), c("c2", "p"), c("r")]);
    expect(rows.map((r) => r.lane)).toEqual([0, 1, 2, 0]);
    expect(rows[1]!.edges).toEqual([
      { from: 1, to: 1, color: 1, kind: "parent" },
      { from: 0, to: 0, color: 0, kind: "pass" },
    ]);
    // c2 bends into the lane that already waits for p.
    expect(rows[2]!.edges).toEqual([
      { from: 2, to: 1, color: 2, kind: "parent" },
      { from: 0, to: 0, color: 0, kind: "pass" },
      { from: 1, to: 1, color: 1, kind: "pass" },
    ]);
    expect(outgoing(rows[3]!)).toEqual([1]);
    for (let i = 1; i < rows.length; i++)
      expect(incoming(rows[i]!)).toEqual(outgoing(rows[i - 1]!));
  });

  it("reuses a lane after a merge closed it", () => {
    const rows = layoutGraph([
      c("m", "b", "s"),
      c("s", "a"),
      c("b", "a"),
      // A new tip after the merge lane closed takes the free lane 1.
      c("t", "a2"),
      c("a", "z"),
    ]);
    expect(rows[2]!.lanes).toBe(2);
    expect(rows[3]!.lane).toBe(1);
    expect(rows[3]!.child).toBe(false);
    // A new stream gets the next color.
    expect(rows[3]!.color).toBe(2);
    expect(rows[4]!.lane).toBe(0);
  });

  it("does not start a new lane where one ends in the same row", () => {
    // b's first parent a waits in lane 1, so lane 1 joins lane 0 and ends.
    // The second parent q must not take lane 1, or the lines would cross.
    const rows = layoutGraph([c("p", "b"), c("x", "a"), c("b", "a", "q")]);
    expect(rows[2]!.edges).toEqual([
      { from: 0, to: 0, color: 0, kind: "parent" },
      { from: 0, to: 2, color: 2, kind: "merge" },
      { from: 1, to: 0, color: 1, kind: "merge" },
    ]);
  });

  it("lets a later parent take the node lane it left", () => {
    // y bends into lane 0 for a. Its second parent q starts below the node.
    const rows = layoutGraph([c("x", "a"), c("y", "a", "q")]);
    expect(rows[1]!.edges).toEqual([
      { from: 1, to: 0, color: 1, kind: "parent" },
      { from: 1, to: 1, color: 2, kind: "merge" },
      { from: 0, to: 0, color: 0, kind: "pass" },
    ]);
  });

  it("links each row bottom to the next row top", () => {
    const commits = randomHistory(400, 7);
    const rows = layoutGraph(commits);
    for (let i = 1; i < rows.length; i++)
      expect(incoming(rows[i]!)).toEqual(outgoing(rows[i - 1]!));
    for (const row of rows) {
      expect(row.color).toBeGreaterThanOrEqual(0);
      expect(row.color).toBeLessThan(GRAPH_COLORS);
      for (const edge of row.edges) expect(edge.color).toBeLessThan(GRAPH_COLORS);
    }
  });

  it("gives the same rows for the same input", () => {
    const commits = randomHistory(300, 3);
    expect(layoutGraph(commits)).toEqual(layoutGraph(commits));
    // A longer page does not change the rows already laid out.
    const longer = layoutGraph(commits);
    expect(layoutGraph(commits.slice(0, 120))).toEqual(longer.slice(0, 120));
  });

  it("lays out 1000 commits in under 50 ms", () => {
    const commits = randomHistory(1000, 11);
    layoutGraph(commits);
    const start = performance.now();
    layoutGraph(commits);
    expect(performance.now() - start).toBeLessThan(50);
  });
});

describe("sameGraphRow", () => {
  it("matches rows of a new run by value", () => {
    const commits = randomHistory(300, 5);
    const before = layoutGraph(commits);
    // A new commit on top of the first one, as a push brings it.
    const after = layoutGraph([c("new", commits[0]!.hash), ...commits]);
    expect(after[1]).not.toBe(before[0]);
    // Only the old top row changes: it has a child now.
    const changed = before.flatMap((row, i) => (sameGraphRow(row, after[i + 1]!) ? [] : [i]));
    expect(changed).toEqual([0]);
  });

  it("tells rows apart by every field", () => {
    const row = {
      lane: 1,
      color: 2,
      lanes: 3,
      child: true,
      edges: [{ from: 1, to: 1, color: 2, kind: "parent" as const }],
    };
    const copy = { ...row, edges: row.edges.map((e) => ({ ...e })) };
    expect(sameGraphRow(row, copy)).toBe(true);
    expect(sameGraphRow(row, { ...copy, lane: 0 })).toBe(false);
    expect(sameGraphRow(row, { ...copy, color: 0 })).toBe(false);
    expect(sameGraphRow(row, { ...copy, lanes: 2 })).toBe(false);
    expect(sameGraphRow(row, { ...copy, child: false })).toBe(false);
    expect(sameGraphRow(row, { ...copy, edges: [] })).toBe(false);
    for (const change of [{ from: 0 }, { to: 0 }, { color: 0 }, { kind: "merge" as const }])
      expect(sameGraphRow(row, { ...copy, edges: [{ ...copy.edges[0]!, ...change }] })).toBe(false);
  });
});

describe("graphOrder", () => {
  it("returns the same list when every child comes first", () => {
    const commits = randomHistory(200, 5);
    expect(graphOrder(commits)).toBe(commits);
  });

  it("moves a parent down to right after its last child", () => {
    // x and c share the parent p. Git put p above c.
    const order = graphOrder([c("x", "p"), c("p", "r"), c("c", "p"), c("r")]);
    expect(order.map((commit) => commit.hash)).toEqual(["x", "c", "p", "r"]);
  });

  it("moves a held parent's own held parent after it", () => {
    // q waits for t and p, p waits for c.
    const order = graphOrder([c("t", "q"), c("q"), c("p", "q"), c("c", "p")]);
    expect(order.map((commit) => commit.hash)).toEqual(["t", "c", "p", "q"]);
  });

  it("drops a hash that comes twice", () => {
    const order = graphOrder([c("b", "a"), c("a"), c("b", "a")]);
    expect(order.map((commit) => commit.hash)).toEqual(["b", "a"]);
  });

  it("puts every child first in a shuffled history, and the layout stays linked", () => {
    for (const seed of [2, 9, 17]) {
      const history = randomHistory(300, seed);
      const shuffled = liftParents(history, seed);
      const order = graphOrder(shuffled);
      expect(new Set(order.map((commit) => commit.hash))).toEqual(
        new Set(history.map((commit) => commit.hash)),
      );
      expect(order).toHaveLength(history.length);
      const at = new Map(order.map((commit, i) => [commit.hash, i]));
      for (const commit of order)
        for (const parent of commit.parents)
          expect(at.get(parent)!).toBeGreaterThan(at.get(commit.hash)!);
      const rows = layoutGraph(order);
      for (let i = 1; i < rows.length; i++)
        expect(incoming(rows[i]!)).toEqual(outgoing(rows[i - 1]!));
    }
  });
});

/**
 * Move some commits above one of their children, as Git's default order
 * does when commit dates tie or disagree.
 */
function liftParents(commits: GraphCommit[], seed: number): GraphCommit[] {
  let state = seed;
  const random = () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
  const list = commits.slice();
  for (let n = 0; n < 40; n++) {
    const from = 1 + Math.floor(random() * (list.length - 1));
    const to = Math.max(0, from - 1 - Math.floor(random() * 6));
    const [moved] = list.splice(from, 1);
    list.splice(to, 0, moved!);
  }
  return list;
}

/**
 * A history in date order: each commit points at older ones, with merges
 * and a few branches that stay open.
 */
function randomHistory(count: number, seed: number): GraphCommit[] {
  let state = seed;
  const random = () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
  const hashes = Array.from({ length: count }, (_, i) => `h${i}`);
  return hashes.map((hash, i) => {
    const older = count - i - 1;
    if (older === 0) return { hash, parents: [] };
    const pick = () => hashes[i + 1 + Math.floor(random() * Math.min(older, 8))]!;
    const parents = [pick()];
    if (random() < 0.2) parents.push(pick());
    return { hash, parents };
  });
}
