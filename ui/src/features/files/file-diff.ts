import { diffLines } from "diff";
import { normalizeFileLines, type FileHunk } from "./file-hunk";

export function fileHunks(original: string, current: string): FileHunk[] {
  const before = normalizeFileLines(original);
  const after = normalizeFileLines(current);
  const changes = diffLines(before, after, { timeout: 500 });
  if (!changes) return coarseHunk(before, after);
  const hunks: FileHunk[] = [];
  let next = 1;
  let oldLine = 1;
  let pending: FileHunk | undefined;
  for (const change of changes) {
    if (!change.added && !change.removed) {
      next += change.count;
      oldLine += change.count;
      pending = undefined;
      continue;
    }
    if (!pending) {
      // A deletion sits in the gap after the last surviving line.
      const anchor = Math.max(1, next - 1);
      pending = {
        originalStart: oldLine,
        start: anchor,
        end: anchor,
        beforeFirst: next === 1,
        removed: "",
        added: "",
      };
      hunks.push(pending);
    }
    if (change.removed) {
      pending.removed += change.value;
      oldLine += change.count;
    } else {
      pending.beforeFirst = false;
      pending.start = next;
      next += change.count;
      pending.end = next - 1;
      pending.added += change.value;
    }
  }
  return hunks;
}

// For a large rewrite that exceeds the diff time budget, show the changed
// span as one block. Preserve its unchanged prefix and suffix.
function coarseHunk(original: string, current: string): FileHunk[] {
  const lines = (text: string) => text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const before = lines(original);
  const after = lines(current);
  let first = 0;
  let oldEnd = before.length;
  let newEnd = after.length;
  while (first < oldEnd && first < newEnd && before[first] === after[first]) first++;
  while (oldEnd > first && newEnd > first && before[oldEnd - 1] === after[newEnd - 1]) {
    oldEnd--;
    newEnd--;
  }
  if (newEnd === first && oldEnd === first) return [];
  const start = newEnd > first ? first + 1 : Math.max(1, first);
  return [
    {
      originalStart: first + 1,
      start,
      end: Math.max(start, newEnd),
      beforeFirst: newEnd === 0,
      added: after.slice(first, newEnd).join(""),
      removed: before.slice(first, oldEnd).join(""),
    },
  ];
}
