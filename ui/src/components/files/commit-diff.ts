/**
 * One file's patch, read into rows with old and new line numbers.
 *
 * `index` is the row's line in the patch text, so syntax tokens computed over
 * the whole patch line up with the rows that show it.
 */
export type DiffRow =
  | { kind: "hunk"; index: number; text: string }
  | {
      kind: "add" | "del" | "context";
      index: number;
      text: string;
      old?: number;
      new?: number;
    }
  | { kind: "note"; index: number; text: string };

export interface ParsedPatch {
  /** Header lines worth showing, such as a mode change. */
  meta: string[];
  rows: DiffRow[];
}

// The file header already names the file, its status and its rename.
const SHOWN_ELSEWHERE =
  /^(diff --git |index |--- |\+\+\+ |rename from |rename to |copy from |copy to |similarity index |dissimilarity index |new file mode |deleted file mode |Binary files )/;

export function parsePatch(patch: string): ParsedPatch {
  const meta: string[] = [];
  const rows: DiffRow[] = [];
  if (!patch) return { meta, rows };
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  patch.split("\n").forEach((text, index) => {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (hunk) {
      inHunk = true;
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      rows.push({ kind: "hunk", index, text });
    } else if (!inHunk) {
      if (!SHOWN_ELSEWHERE.test(text)) meta.push(text);
    } else if (text.startsWith("+")) {
      rows.push({ kind: "add", index, text, new: newLine++ });
    } else if (text.startsWith("-")) {
      rows.push({ kind: "del", index, text, old: oldLine++ });
    } else if (text.startsWith("\\")) {
      rows.push({ kind: "note", index, text });
    } else {
      rows.push({
        kind: "context",
        index,
        text,
        old: oldLine++,
        new: newLine++,
      });
    }
  });
  return { meta, rows };
}

/** Split a path for display: muted folder, then the name. */
export function splitPath(path: string): { folder: string; name: string } {
  const slash = path.lastIndexOf("/");
  return slash < 0
    ? { folder: "", name: path }
    : { folder: path.slice(0, slash + 1), name: path.slice(slash + 1) };
}
