export type Range = [number, number];

export interface PaletteMatch {
  score: number;
  /** Matched spans of the label, merged and in order. */
  ranges: Range[];
}

const WORD_START = /[\s/_\-.:,()]/;

function subsequence(text: string, token: string): number[] | null {
  const indices: number[] = [];
  let from = 0;
  for (const char of token) {
    const at = text.indexOf(char, from);
    if (at < 0) return null;
    indices.push(at);
    from = at + 1;
  }
  return indices;
}

/** Prefix beats word start beats substring beats scattered characters. */
function scoreToken(text: string, token: string): PaletteMatch | null {
  const at = text.indexOf(token);
  if (at === 0) return { score: 100, ranges: [[0, token.length]] };
  if (at > 0) {
    const wordStart = WORD_START.test(text[at - 1] ?? "");
    return { score: wordStart ? 70 : 45, ranges: [[at, at + token.length]] };
  }
  const indices = subsequence(text, token);
  if (!indices) return null;
  const first = indices[0] ?? 0;
  const last = indices[indices.length - 1] ?? 0;
  const gaps = last - first + 1 - token.length;
  return { score: Math.max(5, 25 - gaps * 2), ranges: indices.map((i) => [i, i + 1]) };
}

export function mergeRanges(ranges: Range[]): Range[] {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const merged: Range[] = [];
  for (const [start, end] of sorted) {
    const last = merged[merged.length - 1];
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

/**
 * Every query token must match the label or one keyword. Keyword matches
 * count less and never highlight. An empty query matches everything.
 */
export function matchPalette(
  query: string,
  label: string,
  keywords: readonly string[] = [],
): PaletteMatch | null {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) return { score: 0, ranges: [] };
  const text = label.toLowerCase();
  const extra = keywords.map((keyword) => keyword.toLowerCase());
  let score = 0;
  const ranges: Range[] = [];
  for (const token of tokens) {
    const direct = scoreToken(text, token);
    if (direct) {
      score += direct.score;
      ranges.push(...direct.ranges);
      continue;
    }
    let best = 0;
    for (const keyword of extra) {
      const match = scoreToken(keyword, token);
      if (match) best = Math.max(best, match.score * 0.6);
    }
    if (!best) return null;
    score += best;
  }
  return { score: score - Math.min(text.length, 40) * 0.05, ranges: mergeRanges(ranges) };
}

/** Split a label into plain and matched parts for rendering. */
export function splitHighlight(
  text: string,
  ranges: readonly Range[],
): { text: string; hit: boolean }[] {
  const parts: { text: string; hit: boolean }[] = [];
  let cursor = 0;
  for (const [start, end] of ranges) {
    if (start > cursor) parts.push({ text: text.slice(cursor, start), hit: false });
    parts.push({ text: text.slice(start, end), hit: true });
    cursor = end;
  }
  if (cursor < text.length) parts.push({ text: text.slice(cursor), hit: false });
  return parts;
}
