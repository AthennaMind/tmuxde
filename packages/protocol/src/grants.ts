import { z } from "zod";

/**
 * What one shared credential is allowed to do.
 *
 * A grant is the answer to "someone paired with this machine — now what may
 * they touch?". Before grants existed the answer was "everything", because a
 * token was a token; `mtmux share <session>` needs it to be "that session, and
 * nothing else".
 *
 * ## Local-only, permanently
 *
 * Grants live in `~/.mtmux/grants.json` on the machine being shared and are
 * never sent to the broker. That is not an implementation detail to revisit
 * later: a grant maps a session *name* to a browser, and handing the broker
 * that mapping is precisely what invariant #2 exists to prevent. The broker
 * routes opaque slots; it must not be able to learn that `$3` is called
 * "prod-deploy" or who opened it.
 *
 * ## Why sessions are matched by id
 *
 * `session_id` (`$3`), not `session_name`. Names are mutable — `session:rename`
 * is a first-class message — so matching by name means a rename either
 * silently moves the grant to whatever takes the old name, which is a
 * privilege-escalation primitive, or silently voids it, which looks like a
 * bug. Ids are stable for the life of the tmux server, and `SessionInfo`
 * already carries one, so this costs nothing.
 *
 * Ids restart at `$0` when the tmux server does, hence `tmuxServerPid`: on a
 * mismatch the holder re-pins by name once and logs it. Failing closed there
 * would kill every share across a reboot, which is user-hostile for a tool
 * whose whole point is surviving disconnection.
 */

/** A session a grant names, pinned by id with the name kept for display. */
export const GrantSession = z.object({
  /** tmux `session_id`, e.g. `$3`. The thing actually matched on. */
  id: z.string().min(1).max(32),
  /** The name at the time of sharing. Display only — it may be stale. */
  name: z.string().max(256),
});
export type GrantSession = z.infer<typeof GrantSession>;

/**
 * How wide the grant is.
 *
 * `all` is the legacy shape and what the machine's own `AUTH_TOKEN` resolves
 * to, so the self-hosted path is byte-for-byte what it was.
 */
export const GrantScope = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("all") }),
  z.object({
    kind: z.literal("sessions"),
    sessions: z.array(GrantSession).max(64),
  }),
]);
export type GrantScope = z.infer<typeof GrantScope>;

/**
 * File access, which is off by default for anything narrower than `all`.
 *
 * There is no principled middle setting. `ALLOWED_PATHS` defaults to `$HOME`,
 * so a "share of one tmux session" that shipped with read *and write* over the
 * whole home directory — `file:delete` included — would not be a share of one
 * session in any sense the recipient's `~/.ssh` would recognise. Deriving a
 * narrower root from `pane_current_path` looks like a boundary and is not one,
 * because `cd /` moves it. So: off, or the operator's existing allow-list.
 */
export const GrantFiles = z.enum(["none", "read", "write"]);
export type GrantFiles = z.infer<typeof GrantFiles>;

export const GrantRecord = z.object({
  /** `grn_` + 16 base32 characters. */
  id: z.string().min(1).max(64),
  /** Human label for `mtmux share list`. */
  label: z.string().max(128),
  scope: GrantScope,
  /**
   * Read-write is the default, and is deliberately *not* sold as a boundary.
   *
   * Read-only is: the relay attaches such a holder to a grouped clone with no
   * prefix and an empty key table, so there is no key sequence that reaches a
   * shell. Read-write scopes the *client* — useful against mistakes and a
   * compromised browser — but the person is typing into a shell on this
   * machine and can do anything the account can.
   */
  readOnly: z.boolean(),
  files: GrantFiles,
  createdAt: z.number().int().nonnegative(),
  /** Epoch millis, or null for a grant that never expires on its own. */
  expiresAt: z.number().int().nonnegative().nullable(),
  revokedAt: z.number().int().nonnegative().nullable(),
  /**
   * The tmux server this grant's session ids belong to.
   *
   * Null means "unknown, do not try to validate" — used by the full grant,
   * which has no ids to invalidate.
   */
  tmuxServerPid: z.number().int().nonnegative().nullable(),
  /**
   * SHA-256 hex of the token. The token itself is never written to disk.
   *
   * The token is `deriveSessionKeys().directToken`, which both ends compute
   * independently from the CPace shared secret — so there is no round trip in
   * which a grant id could be handed to the browser to prepend. Storing only
   * the digest means `grants.json` leaking is not the same as the shares
   * leaking.
   */
  tokenHash: z.string().regex(/^[0-9a-f]{64}$/),
  /** The paired device, when one is known. Display only. */
  peerDeviceId: z.string().max(128).optional(),
});
export type GrantRecord = z.infer<typeof GrantRecord>;

/** The on-disk file. Versioned so a format change is detectable, not fatal. */
export const GrantFile = z.object({
  version: z.literal(1),
  grants: z.array(GrantRecord),
});
export type GrantFile = z.infer<typeof GrantFile>;

/** Whether a grant is usable right now. Order: revoked, then expired. */
export function isGrantActive(
  grant: GrantRecord,
  now: number = Date.now(),
): boolean {
  if (grant.revokedAt !== null) return false;
  if (grant.expiresAt !== null && grant.expiresAt <= now) return false;
  return true;
}
