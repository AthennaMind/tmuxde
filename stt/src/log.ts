/**
 * One JSON line per event on stdout.
 *
 * Never pass transcripts or audio here. What someone said stays between their
 * browser and their terminal.
 */
export function log(
  level: "info" | "warn" | "error",
  msg: string,
  fields: Record<string, unknown> = {},
): void {
  const line = JSON.stringify({ time: new Date().toISOString(), level, msg, ...fields });
  if (level === "info") console.log(line);
  else console.error(line);
}
