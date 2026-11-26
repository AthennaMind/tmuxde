export interface FileHunk {
  originalStart: number;
  start: number;
  end: number;
  beforeFirst: boolean;
  removed: string;
  added: string;
}

export function hunkKind(hunk: FileHunk) {
  if (!hunk.added) return "removed";
  return hunk.removed ? "modified" : "added";
}

export function hunkBlocks(hunk: FileHunk) {
  const blocks = [];
  for (const [prefix, value] of [
    ["-", hunk.removed],
    ["+", hunk.added],
  ] as const) {
    if (!value) continue;
    const className =
      prefix === "-"
        ? "bg-signal-failed-surface text-term-removed"
        : "bg-signal-done-surface text-term-added";
    const lines = value
      .replace(/\n$/, "")
      .split("\n")
      .map((line) => prefix + " " + line);
    if (!value.endsWith("\n")) lines.push("\\ No newline at end of file");
    blocks.push({ className, text: lines.join("\n"), rows: lines.length });
  }
  return blocks;
}

export function normalizeFileLines(text: string) {
  return text.replace(/\r\n?/g, "\n");
}

/** Index coordinates survive edits above the open change. A tracked buffer
 * line also identifies it when staging another change moves the index. */
export function findOpenHunk(hunks: FileHunk[], previous: FileHunk, line: number) {
  const sameIndex = hunks.find(
    (h) => h.originalStart === previous.originalStart && h.removed === previous.removed,
  );
  if (sameIndex) return sameIndex;

  // Editing an adjacent line can merge two changes or split one in two.
  // Only follow overlapping text at the tracked line.
  function sharesText(a: string, b: string) {
    return a !== "" && b !== "" && (a.includes(b) || b.includes(a));
  }
  return hunks.find(
    (h) =>
      h.start <= line &&
      line <= h.end &&
      h.beforeFirst === previous.beforeFirst &&
      (sharesText(h.removed, previous.removed) || sharesText(h.added, previous.added)),
  );
}
