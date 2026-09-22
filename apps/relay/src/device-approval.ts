import type {
  DeviceApprovalRequestMessage,
  DeviceApprovalResolvedMessage,
} from "@repo/protocol";
import { createLogger } from "@repo/logger";
import { broadcastWhere, getAllConnections } from "./connection-manager.js";
import type { ConnectionState } from "./connection-manager.js";
import { isFullGrant } from "./grant.js";
import { isGrantActive } from "@repo/protocol";

const logger = createLogger("relay:approval");

/**
 * Asking the app, rather than the machine, whether to admit a new device.
 *
 * ## Why this exists at all
 *
 * Every approval path this product had ran through the machine: a TTY prompt
 * in `mtmux start`, or a window opened by `mtmux approve`. Both assume you can
 * get to a keyboard on the host. The entire premise of mtmux is that you are
 * *not* at that keyboard — you are on a phone, somewhere else, which is the
 * exact situation in which a second device asking to pair is both most likely
 * and most worth looking at.
 *
 * So the phone already holding a session is the natural approver, and until now
 * it was the one party never asked. It only found out afterwards, via
 * `device:paired`.
 *
 * ## Who is allowed to answer
 *
 * Full-grant connections only. A read-only share must not be able to admit a
 * device, because admitting a device grants more than the share holds — it is
 * privilege escalation dressed as a dialog. `POLICY["device:approve"]` refuses
 * the answer on the way in; this module refuses to even ask on the way out.
 * Both halves, because either one alone is a single point of failure.
 *
 * ## What "no answer" means
 *
 * The same thing it means everywhere else in this codebase: no. The request
 * expires, `ask()` resolves, and the device is not admitted. Silence is not
 * consent. The one deliberate difference from `approve-control.ts` is that
 * this channel can *abstain* — resolving `null` when there is nobody connected
 * to ask, or when the last eligible connection drops with the question still on
 * screen. Abstaining is not denying: it hands the decision back to the TTY and
 * `mtmux approve` rather than answering for them. Collapsing the two would mean
 * that opening a browser tab quietly disabled the terminal prompt.
 *
 * ## One at a time
 *
 * Matching the broker's one-live-request-per-device rule and
 * `approve-control.ts`'s. A second request while one is on screen is not
 * queued: the browser's half of the SAS exchange is an ephemeral key with a
 * 120-second TTL, so anything waiting behind a question would expire before its
 * turn. It abstains instead, and the other channels handle it.
 */

/** Matches `OFFER_TIMEOUT_MS` in the CLI: under the broker's 120 s request TTL. */
export const APPROVAL_TIMEOUT_MS = 100_000;

export type DeviceApprovalInput = {
  /** Omitted for a code pairing, where the code was the shared secret. */
  sas?: string;
  deviceLabel: string;
  accountEmail: string;
  via?: "code" | "request" | "returning";
};

export type AskOptions = {
  timeoutMs?: number;
  now?: () => number;
  /** Abort when another channel has already answered. Resolves `null`. */
  signal?: AbortSignal;
};

type Pending = {
  request: DeviceApprovalRequestMessage;
  settle: (answer: boolean | null) => void;
  timer: NodeJS.Timeout;
  onAbort: (() => void) | null;
  signal: AbortSignal | null;
};

let pending: Pending | null = null;
let counter = 0;

/**
 * May this connection answer "let a device in?".
 *
 * Deliberately stricter than `isFullGrant`, which asks only about *scope* —
 * a read-only share of the whole machine passes that and must not pass this.
 * The three clauses mirror `POLICY["device:approve"]` exactly (`fullScopeOnly`,
 * `write`, and the liveness check every message goes through), because the
 * question and the answer disagreeing would mean a dialog that cannot be
 * actioned: a button the relay refuses, on the most important prompt in the
 * product.
 */
function mayApprove(conn: ConnectionState): boolean {
  return (
    conn.authenticated &&
    isFullGrant(conn.grant) &&
    !conn.grant.readOnly &&
    isGrantActive(conn.grant)
  );
}

/** Connections that may both see and answer a request. */
function approvers(): ConnectionState[] {
  return getAllConnections().filter(mayApprove);
}

function finish(
  answer: boolean | null,
  reason: DeviceApprovalResolvedMessage["reason"],
): void {
  if (!pending) return;
  const p = pending;
  pending = null;
  clearTimeout(p.timer);
  if (p.onAbort && p.signal) p.signal.removeEventListener("abort", p.onAbort);

  // Tell every dialog the question is closed, including the one that answered
  // it. A phone left showing a decision that can no longer be made is worse
  // than no dialog: the next tap does nothing and the user cannot tell whether
  // it worked.
  broadcastWhere((conn) =>
    mayApprove(conn)
      ? {
          type: "device:approval-resolved",
          id: p.request.id,
          approved: answer === true,
          reason,
        }
      : null,
  );
  p.settle(answer);
}

/**
 * Put the question in front of every connected browser that may answer it.
 *
 * Resolves `true`/`false` for a human's answer or a timeout, and `null` to
 * abstain — see the header. Never throws: a broken approver must not be able to
 * stop the other channels from deciding.
 */
export function askDeviceApproval(
  input: DeviceApprovalInput,
  opts: AskOptions = {},
): Promise<boolean | null> {
  const now = opts.now ?? Date.now;
  const timeoutMs = opts.timeoutMs ?? APPROVAL_TIMEOUT_MS;

  if (opts.signal?.aborted) return Promise.resolve(null);
  // One at a time, and a second question abstains rather than queues.
  if (pending) return Promise.resolve(null);
  if (approvers().length === 0) return Promise.resolve(null);

  const request: DeviceApprovalRequestMessage = {
    type: "device:approval-request",
    id: `app-${(counter += 1).toString(36)}-${now().toString(36)}`,
    deviceLabel: input.deviceLabel,
    accountEmail: input.accountEmail,
    ...(input.sas ? { sas: input.sas } : {}),
    via: input.via ?? "request",
    expiresAt: now() + timeoutMs,
  };

  return new Promise<boolean | null>((resolve) => {
    const timer = setTimeout(() => finish(false, "expired"), timeoutMs);
    timer.unref?.();

    const signal = opts.signal ?? null;
    const onAbort = signal ? () => finish(null, "withdrawn") : null;
    if (signal && onAbort) signal.addEventListener("abort", onAbort);

    pending = { request, settle: resolve, timer, onAbort, signal };

    let shown = 0;
    broadcastWhere((conn) => {
      if (!mayApprove(conn)) return null;
      shown += 1;
      return request;
    });
    logger.info({ shown }, "Device approval requested in-app");
  });
}

/**
 * A browser answered. Returns false when the request is no longer live.
 *
 * First answer wins. Two phones both showing the dialog is the normal case, not
 * an edge one, and the loser is told via `device:approval-resolved` rather than
 * being left to guess.
 */
export function resolveDeviceApproval(id: string, approved: boolean): boolean {
  if (!pending || pending.request.id !== id) return false;
  finish(approved === true, "decided");
  return true;
}

/**
 * The live question, for a connection that has just authenticated.
 *
 * Without this, opening the app *because* you got a notification would show
 * nothing: the broadcast went out before your socket existed. The request is
 * time-boxed and idempotent, so replaying it costs nothing.
 */
export function pendingApprovalFor(
  conn: ConnectionState,
): DeviceApprovalRequestMessage | null {
  if (!pending) return null;
  if (!mayApprove(conn)) return null;
  return pending.request;
}

/**
 * The last browser that could answer has gone.
 *
 * Abstain rather than deny: the question was never put to a human, so there is
 * no human answer to honour. The TTY and `mtmux approve` are still there.
 */
export function noteApproversChanged(): void {
  if (!pending) return;
  if (approvers().length > 0) return;
  finish(null, "withdrawn");
}

/** Test seam. Drops any live question without answering it. */
export function resetDeviceApproval(): void {
  finish(null, "withdrawn");
  counter = 0;
}
