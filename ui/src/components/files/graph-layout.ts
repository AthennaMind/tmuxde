/**
 * Lane layout for the commit graph.
 *
 * Input is the loaded commits, newest first, with every child before its
 * parents. `graphOrder` makes that so for Git's default order. Output is one
 * row per commit. A row draws its own half rows only, so rows can render and
 * scroll on their own:
 *
 * - Top half, from the row top to the centre: a straight line in every lane
 *   that comes in from the row above. Those are the `from` lane of each edge
 *   that does not start at the node, plus the node lane when `child` is set.
 * - Bottom half, from the centre to the row bottom: each edge, from lane
 *   `from` at the centre to lane `to` at the bottom. Edges whose `from` is
 *   the node lane start at the node.
 *
 * Lanes never move sideways. A lane that ends leaves a gap, and the next new
 * lane takes the first gap. At most one lane waits for any one commit: when
 * two would, the right one bends into the left one.
 *
 * A parent that came before its child is treated like a parent beyond the
 * loaded commits: its lane stays open to the bottom, and later children of
 * it join that one lane.
 */

export interface GraphCommit {
  hash: string;
  parents: string[];
}

export interface GraphEdge {
  /** Lane at the row centre. */
  from: number;
  /** Lane at the row bottom. */
  to: number;
  /** Index into the lane colors. */
  color: number;
  /**
   * `pass`: a lane that goes past this commit. `parent`: from the node to its
   * first parent. `merge`: from the node to a later parent, or a lane that
   * joins another lane waiting for the same commit.
   */
  kind: "pass" | "parent" | "merge";
}

export interface GraphRow {
  /** Lane of the commit node. */
  lane: number;
  /** Color of the commit node and its lane. */
  color: number;
  /** Lanes the row needs drawn, so its width. */
  lanes: number;
  /** A loaded child draws a line into the node from above. */
  child: boolean;
  edges: GraphEdge[];
}

/** Lane colors cycle over this many values. */
export const GRAPH_COLORS = 6;

/**
 * The loaded commits with every child before its parents, and each hash
 * once.
 *
 * Git's default order puts the newest commit date first. When dates tie or
 * disagree, a parent can come before one of its children. Such a parent
 * moves down to right after its last loaded child, and its own parents
 * follow it the same way. Every other commit keeps its place. Returns the
 * input itself when nothing moves.
 */
export function graphOrder<T extends GraphCommit>(commits: readonly T[]): readonly T[] {
  const byHash = new Map<string, T>();
  for (const commit of commits) if (!byHash.has(commit.hash)) byHash.set(commit.hash, commit);
  // Loaded children each commit still waits for.
  const waiting = new Map<string, number>();
  for (const commit of byHash.values())
    for (const parent of new Set(commit.parents))
      if (parent !== commit.hash && byHash.has(parent))
        waiting.set(parent, (waiting.get(parent) ?? 0) + 1);

  const held = new Set<string>();
  const out: T[] = [];
  const emit = (first: T) => {
    const stack = [first];
    while (stack.length) {
      const commit = stack.pop()!;
      out.push(commit);
      const parents = [...new Set(commit.parents)];
      // Reversed, so the first parent comes out of the stack first.
      for (let i = parents.length - 1; i >= 0; i--) {
        const parent = parents[i]!;
        const left = waiting.get(parent);
        if (parent === commit.hash || left === undefined) continue;
        waiting.set(parent, left - 1);
        if (left === 1 && held.delete(parent)) stack.push(byHash.get(parent)!);
      }
    }
  };
  const done = new Set<string>();
  for (const commit of commits) {
    if (done.has(commit.hash)) continue;
    done.add(commit.hash);
    if ((waiting.get(commit.hash) ?? 0) > 0) held.add(commit.hash);
    else emit(commit);
  }
  const same = out.length === commits.length && out.every((c, i) => c === commits[i]);
  return same ? commits : out;
}

/**
 * Two rows draw the same. `layoutGraph` builds new rows on every run, so a
 * new first page compares rows by value to keep unchanged ones as they are.
 */
export function sameGraphRow(a: GraphRow, b: GraphRow): boolean {
  if (a === b) return true;
  if (
    a.lane !== b.lane ||
    a.color !== b.color ||
    a.lanes !== b.lanes ||
    a.child !== b.child ||
    a.edges.length !== b.edges.length
  )
    return false;
  return a.edges.every((edge, i) => {
    const other = b.edges[i]!;
    return (
      edge.from === other.from &&
      edge.to === other.to &&
      edge.color === other.color &&
      edge.kind === other.kind
    );
  });
}

export function layoutGraph(commits: readonly GraphCommit[]): GraphRow[] {
  // The commit each lane waits for, or null for a gap.
  const slots: (string | null)[] = [];
  const colors: number[] = [];
  let nextColor = 0;
  const rows: GraphRow[] = [];

  const open = (hash: string, avoid: ReadonlySet<number>): number => {
    let index = slots.findIndex((slot, i) => slot === null && !avoid.has(i));
    if (index < 0) index = slots.length;
    slots[index] = hash;
    colors[index] = nextColor;
    nextColor = (nextColor + 1) % GRAPH_COLORS;
    return index;
  };

  for (const commit of commits) {
    const before = slots.slice();
    let lane = slots.indexOf(commit.hash);
    const child = lane >= 0;
    if (!child) lane = open(commit.hash, new Set());
    const color = colors[lane]!;
    const edges: GraphEdge[] = [];
    // Lanes that end in this row. A new lane must not start there, or its
    // line would cross the one going away.
    const ended = new Set<number>();
    // Lanes that join another lane in this row, by lane.
    const joined = new Map<number, number>();

    const parents = commit.parents.filter(
      (parent, i) => parent !== commit.hash && commit.parents.indexOf(parent) === i,
    );
    const [first, ...rest] = parents;
    if (first === undefined) {
      slots[lane] = null;
      ended.add(lane);
    } else {
      const waiting = slots.indexOf(first);
      if (waiting < 0) {
        slots[lane] = first;
        edges.push({ from: lane, to: lane, color, kind: "parent" });
      } else if (waiting < lane) {
        // Another lane already waits for the parent. Bend into it.
        slots[lane] = null;
        ended.add(lane);
        edges.push({ from: lane, to: waiting, color, kind: "parent" });
      } else {
        // The lane on the right joins this one.
        slots[lane] = first;
        slots[waiting] = null;
        ended.add(waiting);
        joined.set(waiting, lane);
        edges.push({ from: lane, to: lane, color, kind: "parent" });
      }
    }
    for (const parent of rest) {
      let target = slots.indexOf(parent);
      if (target < 0) {
        const avoid = new Set(ended);
        // The node lane is free to reuse: its line starts at the node.
        avoid.delete(lane);
        target = open(parent, avoid);
      }
      edges.push({ from: lane, to: target, color: colors[target]!, kind: "merge" });
    }
    before.forEach((slot, i) => {
      if (slot === null || i === lane) return;
      const into = joined.get(i);
      if (into !== undefined) edges.push({ from: i, to: into, color: colors[i]!, kind: "merge" });
      else edges.push({ from: i, to: i, color: colors[i]!, kind: "pass" });
    });
    // Colors of joined lanes were read above. Now the gaps can go.
    while (slots.length && slots[slots.length - 1] === null) {
      slots.pop();
      colors.pop();
    }

    let lanes = lane + 1;
    for (const edge of edges) lanes = Math.max(lanes, edge.from + 1, edge.to + 1);
    rows.push({ lane, color, lanes, child, edges });
  }
  return rows;
}
