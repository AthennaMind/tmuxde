import type { RepoCommit } from "@/protocol";
import { sameGraphRow, type GraphRow } from "./graph-layout";

/** Two commits show the same in a row and open the same commit tab. */
function sameCommit(a: RepoCommit, b: RepoCommit): boolean {
  return (
    a === b ||
    (a.hash === b.hash &&
      a.subject === b.subject &&
      a.author === b.author &&
      a.date === b.date &&
      sameList(a.refs, b.refs) &&
      sameList(a.parents, b.parents))
  );
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((item, i) => item === b[i]);
}

export interface GraphRowProps {
  commit: RepoCommit;
  row: GraphRow;
  selected: boolean;
  tabStop: boolean;
  onFocus: (hash: string) => void;
  onOpen: (commit: RepoCommit) => void;
}

/** A row renders again only when something it shows changed. */
export function sameRowProps(a: GraphRowProps, b: GraphRowProps): boolean {
  return (
    a.selected === b.selected &&
    a.tabStop === b.tabStop &&
    a.onFocus === b.onFocus &&
    a.onOpen === b.onOpen &&
    sameCommit(a.commit, b.commit) &&
    sameGraphRow(a.row, b.row)
  );
}
