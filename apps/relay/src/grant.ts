import type { GrantRecord, GrantScope, SessionInfo } from "@repo/protocol";
import { isGrantActive } from "@repo/protocol";

/**
 * The grant attached to every authenticated connection.
 *
 * Resolution order in `authenticateMessage` is: the machine's own `AUTH_TOKEN`
 * → `FULL_GRANT`, then a registered scoped token → its own record, then
 * failure. That first arm is the whole of legacy compatibility, and it is why
 * the self-hosted path is byte-for-byte unchanged by scoping: an install with
 * no shares only ever sees `FULL_GRANT`, which permits exactly what the relay
 * permitted before this file existed.
 */
export const FULL_GRANT: GrantRecord = Object.freeze({
  id: "grn_full",
  label: "This machine",
  scope: Object.freeze({ kind: "all" }) as GrantScope,
  readOnly: false,
  files: "write",
  createdAt: 0,
  expiresAt: null,
  revokedAt: null,
  tmuxServerPid: null,
  // Never matched against anything: this grant is reached by token identity,
  // not by hash lookup. Zeroed rather than left absent so the type is honest.
  tokenHash: "0".repeat(64),
}) as GrantRecord;

export function isFullGrant(grant: GrantRecord): boolean {
  return grant.scope.kind === "all";
}

/**
 * May this grant touch this session?
 *
 * Matched on tmux `session_id`, with the name as a fallback only when the
 * grant was pinned against a different tmux server than the one running now —
 * a reboot restarts ids at `$0`, and failing closed there would silently kill
 * every share the next time the box came back up.
 */
export function allowsSession(
  grant: GrantRecord,
  session: { id?: string; name: string },
  tmuxServerPid: number | null = null,
): boolean {
  const scope = grant.scope;
  if (scope.kind === "all") return true;
  // An unknown discriminator can only come from a hand-edited or
  // forward-versioned file. Empty, never permissive.
  if (scope.kind !== "sessions") return false;

  const idMatched = session.id
    ? scope.sessions.some((s) => s.id === session.id)
    : false;
  if (idMatched) return true;

  // Only reachable when the ids provably belong to a dead tmux server.
  const serverChanged =
    grant.tmuxServerPid !== null &&
    tmuxServerPid !== null &&
    grant.tmuxServerPid !== tmuxServerPid;
  if (!serverChanged) return false;

  return scope.sessions.some((s) => s.name === session.name);
}

/**
 * May this grant be *told about* an event naming this session?
 *
 * Deliberately separate from `allowsSession`, and deliberately weaker: it
 * matches on name, because the events that need it — `session:killed`,
 * `session:exited` — are about a session that no longer exists and therefore
 * has no id left to resolve.
 *
 * **Never use this to decide access.** Name matching is what
 * `allowsSession` exists to avoid: a rename would hand the grant to whatever
 * took the old name. Here the stakes are different in kind — the worst case is
 * that a holder is told "a session called `work` ended" when the `work` they
 * were granted had already been renamed away. That is a name they were given
 * in the first place, so nothing new is disclosed, and the alternative is a
 * client whose session list silently goes stale.
 */
export function allowsSessionName(grant: GrantRecord, name: string): boolean {
  const scope = grant.scope;
  if (scope.kind === "all") return true;
  if (scope.kind !== "sessions") return false;
  return scope.sessions.some((s) => s.name === name);
}

/** Filter a session list down to what this grant may see. Never throws. */
export function visibleSessions(
  grant: GrantRecord,
  sessions: SessionInfo[],
  tmuxServerPid: number | null = null,
): SessionInfo[] {
  if (isFullGrant(grant)) return sessions;
  return sessions.filter((s) => allowsSession(grant, s, tmuxServerPid));
}

/**
 * Combine two grants into one no wider than either.
 *
 * Used where a scoped connection's request has to be intersected with what a
 * later constraint permits. Written as an explicit narrowing rather than a
 * merge so that "widening" has no expressible form — a property test asserts
 * the result is never broader than `a` on any axis.
 */
export function narrower(a: GrantRecord, b: GrantRecord): GrantRecord {
  const files: GrantRecord["files"] =
    a.files === "none" || b.files === "none"
      ? "none"
      : a.files === "read" || b.files === "read"
        ? "read"
        : "write";

  let scope: GrantScope;
  if (a.scope.kind === "all") {
    scope = b.scope;
  } else if (b.scope.kind === "all") {
    scope = a.scope;
  } else {
    const bIds = new Set(b.scope.sessions.map((s) => s.id));
    scope = {
      kind: "sessions",
      sessions: a.scope.sessions.filter((s) => bIds.has(s.id)),
    };
  }

  return {
    ...a,
    scope,
    files,
    readOnly: a.readOnly || b.readOnly,
    expiresAt: minNullable(a.expiresAt, b.expiresAt),
    revokedAt: minNullable(a.revokedAt, b.revokedAt),
  };
}

/** The earlier of two deadlines, where null means "no deadline". */
function minNullable(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.min(a, b);
}

export { isGrantActive };
