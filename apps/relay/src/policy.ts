import type { ClientMessage, GrantRecord } from "@repo/protocol";
import {
  ClientMessage as ClientMessageSchema,
  isGrantActive,
} from "@repo/protocol";
import { createLogger } from "@repo/logger";
import * as tmux from "./tmux-manager.js";
import { allowsSession, isFullGrant, isRecordingsGrant } from "./grant.js";

const logger = createLogger("relay:policy");

/**
 * What a grant must satisfy for one kind of message.
 *
 * A static table plus a single `enforce()` at the top of `routeMessage`,
 * rather than a guard bolted onto each of the forty-odd cases. The reason is
 * not brevity: it is that the long-term failure mode of per-case guards is a
 * *new* message type shipping without one, silently. `policy.test.ts` iterates
 * the zod union's `.options` and asserts every discriminator appears here, so
 * adding a protocol message without deciding its policy is a failing test
 * rather than a hole.
 */
export type Policy = {
  /** Refused for a read-only grant. */
  write?: true;
  /** Minimum file access this message needs. */
  files?: "read" | "write";
  /**
   * `msg.id` is a tmux pane id that must belong to the attached session.
   *
   * This is finding #2 and it applies to *every* grant, scoped or not:
   * `capturePaneById("%7")` passes the id straight to tmux, which resolves it
   * across the whole server, so `attachedSession` was never a boundary at all.
   */
  paneId?: true;
  /** `msg.id` is a tmux window id that must belong to the attached session. */
  windowId?: true;
  /** Which field names a session that must be in scope. */
  sessionArg?: "name" | "oldName";
  /**
   * Refused for anything narrower than full scope, regardless of read-only.
   *
   * Only `session:rename`. Nobody asked for "the person I shared one session
   * with can rename it", and denying it also removes the entire problem of
   * writing an updated name back into `grants.json` on every rename.
   */
  fullScopeOnly?: true;
  /**
   * `msg.target` names a session that must be in scope.
   *
   * Separate from `sessionArg` because `enforce` reads that one off the top
   * level of the message, and a recording target is nested — `{ target: {
   * kind, session } }`. It must no-op when `msg.target` is absent, or the
   * full-grant sweep in `policy.test.ts` fails on every message that has none.
   */
  recordingTarget?: true;
};

/**
 * The only message types a recordings-scoped grant may send.
 *
 * A `Set` rather than a flag on each entry, because the failure mode being
 * defended against is a *new* message type shipping and being permitted by
 * default. Everything not named here is refused for such a grant, so the
 * default for anything added later is "no".
 */
export const RECORDINGS_GRANT_ALLOWED: ReadonlySet<ClientMessage["type"]> =
  new Set<ClientMessage["type"]>([
    "ping",
    "recording:list",
    "recording:fetch",
    // Not `recording:start`, `stop` or `delete`: those write to the owner's
    // disk and spawn a process. Somebody handed a recording gets to watch it.
  ]);

export const POLICY: Record<ClientMessage["type"], Policy> = {
  // Handled before routing; reaching the router at all is the tunnel case.
  auth: {},
  ping: {},

  // Never refused — filtered instead, in the router. A scoped holder asking
  // for the session list gets their own sessions, not an error.
  "session:list": {},
  // `command` reaches tmux, which runs it through /bin/sh. A scoped share has
  // no business minting sessions, and `write` alone was letting one turn a
  // narrow grant into an arbitrary process.
  "session:create": { write: true, fullScopeOnly: true },
  "session:attach": { sessionArg: "name" },
  "session:detach": {},
  "session:kill": { write: true, sessionArg: "name" },
  "session:rename": { write: true, fullScopeOnly: true, sessionArg: "oldName" },
  "session:windows": { sessionArg: "name" },

  "terminal:input": { write: true },
  // Not a write. A read-only viewer still has a window with a size, and
  // refusing to size their terminal would render the share unusable.
  "terminal:resize": {},

  "command:send": { write: true },
  "command:interrupt": { write: true },
  "command:eof": { write: true },
  "command:clear": { write: true },
  "command:suspend": { write: true },

  "file:list": { files: "read" },
  "file:read": { files: "read" },
  "file:stat": { files: "read" },
  "file:watch": { files: "read" },
  // Tearing down a watcher this connection itself opened. Gating it would
  // leak watchers for a grant that was downgraded mid-connection.
  "file:unwatch": {},
  "file:write": { files: "write" },
  "file:create": { files: "write" },
  "file:mkdir": { files: "write" },
  "file:delete": { files: "write" },
  "file:rename": { files: "write" },
  "file:upload": { files: "write" },

  "pane:list": {},
  "pane:split": { write: true },
  "pane:select": { write: true, paneId: true },
  "pane:zoom": { write: true },
  // Relative, so there is no caller-supplied id to verify: tmux resolves it
  // inside the attached session and cannot step outside it.
  "pane:step": { write: true },
  "pane:resize": { write: true, paneId: true },
  "pane:kill": { write: true, paneId: true },
  "pane:swap": { write: true, paneId: true },
  // A read, but of an arbitrary pane id — which is exactly the bug.
  "pane:capture": { paneId: true },

  "window:list": {},
  "window:create": { write: true },
  "window:select": { write: true, windowId: true },
  "window:step": { write: true },
  "window:kill": { write: true, windowId: true },
  "window:rename": { write: true, windowId: true },
  "window:layout": { write: true },
  "layout:rotate": { write: true },

  "tmux:prefix": { write: true },
  // Copy mode is a per-client view, and reading is what a read-only share is
  // for. It moves nothing the owner can see.
  "tmux:copy-mode": {},
  // Same argument, and the reason it matters more: with tmux on the alternate
  // screen this is the *only* way a client can see scrollback at all. Denying
  // it to a read-only share would leave that share unable to read.
  "tmux:scroll": {},
  // A jump to an absolute point in the same history, and a read of where the
  // view sits. Same argument again: this is reading, not writing.
  "tmux:scroll-to": {},
  "tmux:scroll-state": {},
  "tmux:exit-copy-mode": {},

  // Recording spawns a process and writes to the owner's disk, so it is a
  // write in the sense that matters: a read-only share is "watch, touch
  // nothing". Listing and fetching are not — `fetch` is the entire
  // share-a-recording story, and a share of a recording is read-only by
  // construction.
  "recording:start": { write: true, recordingTarget: true },
  "recording:stop": { write: true },
  "recording:delete": { write: true },
  "recording:list": {},
  "recording:fetch": {},

  /**
   * Answering "let this device in?".
   *
   * `fullScopeOnly` and `write` together, and both are load-bearing. A
   * read-only share that could admit a device would hand out more access than
   * it holds, and a single-session share that could do it would turn a grant
   * over one session into a grant over the machine. This is the one message
   * whose effect is larger than any grant that is not the full one, so the
   * only grant permitted to send it is the full one.
   */
  "device:approve": { write: true, fullScopeOnly: true },
};

export type EnforceResult =
  | { ok: true }
  | { ok: false; code: string; message: string };

const OK: EnforceResult = { ok: true };

/** Uniform refusal, so no call site invents its own wording. */
function deny(code: string, message: string): EnforceResult {
  return { ok: false, code, message };
}

/**
 * Out-of-scope sessions are "not found", never "denied".
 *
 * A scoped holder who gets ACCESS_DENIED for one name and SESSION_NOT_FOUND
 * for another has an oracle for enumerating every session name on the machine
 * by probing. Both answers must be the same answer.
 */
function notFound(name: string): EnforceResult {
  return deny("SESSION_NOT_FOUND", `Session "${name}" not found`);
}

export type EnforceContext = {
  grant: GrantRecord;
  attachedSession: string | null;
  /** The running tmux server's pid, for the id-restart fallback. */
  tmuxServerPid?: number | null;
};

/**
 * The single gate. Called once at the top of `routeMessage`.
 *
 * Async because the pane and window checks have to ask tmux what actually
 * belongs to the attached session — there is no way to answer that from the
 * connection state, and answering it wrongly is the vulnerability.
 */
export async function enforce(
  ctx: EnforceContext,
  msg: ClientMessage,
): Promise<EnforceResult> {
  const policy = POLICY[msg.type];
  if (!policy) {
    // Unreachable while the exhaustiveness test passes; fail closed anyway,
    // because the one time it is reachable is the one time it matters.
    return deny("ACCESS_DENIED", "Not permitted.");
  }

  const { grant } = ctx;

  // `conn.grant` is snapshotted at authentication and never looked at again,
  // so a grant that expires mid-session was simply ignored — the socket kept
  // its rights past `expiresAt`. Re-checked here because this is the one
  // function every message passes through.
  if (!isGrantActive(grant)) {
    return deny("ACCESS_DENIED", "This share has expired.");
  }

  const full = isFullGrant(grant);

  // Checked first and against an allow-list, so a message type added later is
  // denied for a recordings-scoped grant until somebody decides otherwise.
  if (isRecordingsGrant(grant) && !RECORDINGS_GRANT_ALLOWED.has(msg.type)) {
    return deny("ACCESS_DENIED", "This share is a recording, not a session.");
  }

  if (policy.write && grant.readOnly) {
    return deny("READ_ONLY", "This is a read-only session.");
  }

  if (policy.fullScopeOnly && !full) {
    return deny("ACCESS_DENIED", "Not permitted for a shared session.");
  }

  if (policy.files) {
    const held = grant.files;
    const enough =
      policy.files === "read"
        ? held === "read" || held === "write"
        : held === "write";
    if (!enough) {
      return deny("ACCESS_DENIED", "File access is not part of this share.");
    }
  }

  if (policy.recordingTarget) {
    const target = (
      msg as unknown as {
        target?: { session?: unknown; paneId?: unknown };
      }
    ).target;
    const name = target?.session;
    if (typeof name === "string") {
      const inScope = await sessionInScope(ctx, name);
      if (!inScope) return notFound(name);
    }
    // A pane id is a second, independent way to name what gets recorded, and
    // it was unchecked — so a sessions-scoped grant could record a pane of a
    // session it has no rights to. Full grants are exempt for the same reason
    // they are everywhere else: there is nothing narrower to compare against.
    const paneId = target?.paneId;
    if (typeof paneId === "string" && !full) {
      const session = typeof name === "string" ? name : ctx.attachedSession;
      if (!session) return deny("NOT_ATTACHED", "No session attached");
      if (!(await paneBelongs(session, paneId))) {
        return deny("PANE_NOT_FOUND", `Pane "${paneId}" not found`);
      }
    }
  }

  if (policy.sessionArg) {
    const name = (msg as unknown as Record<string, unknown>)[policy.sessionArg];
    if (typeof name === "string") {
      const inScope = await sessionInScope(ctx, name);
      if (!inScope) return notFound(name);
    }
  }

  if (policy.paneId || policy.windowId) {
    const id = (msg as unknown as { id?: unknown }).id;
    if (typeof id !== "string") {
      return deny("INVALID_MESSAGE", "Missing target id.");
    }
    // No attached session means nothing is in scope, which the router's own
    // NOT_ATTACHED guard also reports — but that guard runs after this one,
    // so answering here keeps the two from disagreeing.
    if (!ctx.attachedSession) {
      return deny("NOT_ATTACHED", "No session attached");
    }
    const belongs = policy.paneId
      ? await paneBelongs(ctx.attachedSession, id)
      : await windowBelongs(ctx.attachedSession, id);
    if (!belongs) {
      return policy.paneId
        ? deny("PANE_NOT_FOUND", `Pane "${id}" not found`)
        : deny("WINDOW_NOT_FOUND", `Window "${id}" not found`);
    }
  }

  return OK;
}

/**
 * Is this session name both real and within the grant?
 *
 * Resolved through `listSessions` rather than `sessionExists` so the name can
 * be matched to its id — the grant is pinned by id, and a name lookup that
 * skipped that step would reintroduce exactly the rename hole ids exist to
 * close.
 */
async function sessionInScope(
  ctx: EnforceContext,
  name: string,
): Promise<boolean> {
  if (isFullGrant(ctx.grant)) return true;
  try {
    const sessions = await tmux.listSessions();
    const found = sessions.find((s) => s.name === name);
    if (!found) return false;
    return allowsSession(ctx.grant, found, ctx.tmuxServerPid ?? null);
  } catch (err) {
    // tmux unreachable. Fail closed: a scoped holder must not be widened by
    // an error, and the router's own existence check will report it plainly.
    logger.warn({ err }, "Could not list sessions for a scope check");
    return false;
  }
}

async function paneBelongs(session: string, paneId: string): Promise<boolean> {
  try {
    const panes = await tmux.listPanes(session);
    return panes.some((p) => p.id === paneId);
  } catch (err) {
    logger.warn({ err }, "Could not list panes for a scope check");
    return false;
  }
}

async function windowBelongs(
  session: string,
  windowId: string,
): Promise<boolean> {
  try {
    const windows = await tmux.listWindows(session);
    return windows.some((w) => w.id === windowId);
  } catch (err) {
    logger.warn({ err }, "Could not list windows for a scope check");
    return false;
  }
}

/** Every message type the protocol defines. The test's source of truth. */
export function clientMessageTypes(): string[] {
  return ClientMessageSchema.options.map((option) => {
    const shape = (option as { shape: { type: { value: string } } }).shape;
    return shape.type.value;
  });
}
