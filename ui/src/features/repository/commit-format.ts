// Commit refs and dates, as commit rows and the commit header show them.

export type CommitRef = { name: string; kind: "head" | "branch" | "tag" };

/** Decorations as chips. `origin/HEAD` and the like only repeat a branch. */
export function parseRefs(refs: string[]): CommitRef[] {
  return refs.flatMap((ref): CommitRef[] => {
    if (ref === "HEAD") return [{ name: "HEAD", kind: "head" }];
    if (ref.startsWith("HEAD -> ")) return [{ name: ref.slice(8), kind: "head" }];
    if (ref.startsWith("tag: ")) return [{ name: ref.slice(5), kind: "tag" }];
    if (ref.endsWith("/HEAD")) return [];
    return [{ name: ref, kind: "branch" }];
  });
}

const dateFormat = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});
const monthDay = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
});
const monthYear = new Intl.DateTimeFormat(undefined, {
  month: "short",
  year: "numeric",
});

export function formatCommitDate(date: string): string {
  const time = new Date(date);
  return Number.isNaN(time.getTime()) ? date : dateFormat.format(time);
}

/** Short age for a row: minutes, hours and days, then a date. */
export function commitAge(date: string, now = Date.now()): string {
  const time = new Date(date);
  if (Number.isNaN(time.getTime())) return "";
  const seconds = Math.floor((now - time.getTime()) / 1000);
  if (seconds < 60) return "now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;
  if (seconds < 30 * 86_400) return `${Math.floor(seconds / 86_400)}d`;
  return time.getFullYear() === new Date(now).getFullYear()
    ? monthDay.format(time)
    : monthYear.format(time);
}
