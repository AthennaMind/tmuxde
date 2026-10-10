import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createLogger } from "@repo/logger";
import { config } from "./config.js";

const execFileAsync = promisify(execFile);
const logger = createLogger("relay:clone");

/**
 * The prefix every relay-created clone session carries.
 *
 * Filtered out of `session:list` and the session monitor for *every*
 * connection, including full-scope ones — a clone is relay plumbing, and
 * showing it in the owner's own session list would be a bug rather than a
 * disclosure.
 */
export const CLONE_PREFIX = "__mtmux_";

function tmuxArgs(): string[] {
  return config.tmuxSocket ? ["-S", config.tmuxSocket] : [];
}

/** True for a session this relay created as a viewing clone. */
export function isCloneSession(name: string): boolean {
  return name.startsWith(CLONE_PREFIX);
}

/** tmux rejects `.` and `:` in session names; everything else here is safe. */
function sanitise(part: string): string {
  return part.replace(/[^A-Za-z0-9_-]/g, "");
}

export function cloneNameFor(grantId: string, connId: string): string {
  return `${CLONE_PREFIX}${sanitise(grantId)}_${sanitise(connId)}`;
}

/**
 * Create a grouped clone of `target` that no key sequence can escape.
 *
 * This is the fix for the third finding, and it is the reason a read-only
 * share is a real boundary rather than a suggestion. `attach-session -r` alone
 * is not one: tmux documents that under `-r` the keys bound to
 * `detach-client` **and `switch-client`** still work, and `(` and `)` are
 * bound to `switch-client -p/-n` by default. A viewer attached read-only to
 * the target session can therefore page through every other session on the
 * server.
 *
 * A grouped session (`new-session -t`) shares the target's windows — so the
 * viewer sees the real thing, live — while `prefix`, `prefix2` and `key-table`
 * are *session* options, which means emptying them disarms every key sequence
 * for this client without touching the owner's own client at all.
 *
 * `key-table mtmux-locked` names a table that is never populated. An unbound
 * key in a non-root table is simply discarded, so there is nothing to escape
 * to; `prefix None` removes the way back to the root table.
 */
export async function createReadOnlyClone(
  target: string,
  grantId: string,
  connId: string,
): Promise<string> {
  const name = cloneNameFor(grantId, connId);

  await execFileAsync("tmux", [
    ...tmuxArgs(),
    "new-session",
    "-d",
    "-t",
    target,
    "-s",
    name,
  ]);

  // Best-effort: a clone that exists but could not be locked down is worse
  // than no clone, so a failure here tears it back down rather than attaching.
  try {
    for (const [option, value] of [
      ["prefix", "None"],
      ["prefix2", "None"],
      ["key-table", "mtmux-locked"],
      // Without this, destroying the group's last window would leave the
      // viewer's client attached to the server rather than disconnected.
      ["detach-on-destroy", "on"],
    ] as const) {
      await execFileAsync("tmux", [
        ...tmuxArgs(),
        "set-option",
        "-t",
        name,
        option,
        value,
      ]);
    }
  } catch (err) {
    logger.error({ err, name }, "Could not lock down clone; destroying it");
    await destroyClone(name);
    throw err instanceof Error ? err : new Error(String(err));
  }

  logger.info({ target, name }, "Read-only clone created");
  return name;
}

/** Remove a clone. Never throws — it may already be gone. */
export async function destroyClone(name: string): Promise<void> {
  if (!isCloneSession(name)) return;
  try {
    await execFileAsync("tmux", [...tmuxArgs(), "kill-session", "-t", name]);
  } catch {
    // Already destroyed, or no server running. Either way there is nothing
    // left to clean up and this is called from teardown paths.
  }
}

/**
 * Destroy every clone left behind by a previous relay process.
 *
 * Clones are torn down when their connection closes, but a `kill -9` or a
 * crash skips that. They are harmless — a grouped session holds no extra
 * process — but they accumulate, and one still listed on the tmux server is
 * one that a future name collision could attach to.
 */
export async function sweepOrphanClones(): Promise<number> {
  let names: string[];
  try {
    const { stdout } = await execFileAsync("tmux", [
      ...tmuxArgs(),
      "list-sessions",
      "-F",
      "#{session_name}",
    ]);
    names = stdout.trim().split("\n").filter(Boolean);
  } catch {
    // No server running means no orphans, which is the common case at boot.
    return 0;
  }

  const orphans = names.filter(isCloneSession);
  for (const name of orphans) await destroyClone(name);
  if (orphans.length > 0) {
    logger.info({ count: orphans.length }, "Swept orphaned clone sessions");
  }
  return orphans.length;
}
