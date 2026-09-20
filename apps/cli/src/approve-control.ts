import type http from "node:http";
import { timingSafeEqual } from "node:crypto";

/**
 * The loopback channel between `mtmux approve` and the running `mtmux start`.
 *
 * ## Why this is a window and not a queue
 *
 * A queue is architecturally impossible here, and it is worth writing down
 * because "just queue the requests" is the obvious first design.
 *
 * The browser's half of the SAS exchange is an ephemeral X25519 key that lives
 * only in that tab's memory. `REQUEST_TTL_MS` is 120 seconds, and the broker
 * drops the request the moment the browser's socket closes. There is nothing
 * durable to queue: a request that outlived the tab it came from could not be
 * completed by anyone, because the other half of the key exchange is gone.
 *
 * So the machine says "I am ready to approve for the next N minutes" and the
 * human then goes and clicks in the browser. The approval window is the thing
 * that persists; the request is not.
 *
 * ## Why it talks to the daemon rather than doing its own thing
 *
 * The request arrives on the *daemon's* tunnel socket. `pairRequest` routes via
 * `tunnels.byDevice`, so an approver that registered its own tunnel would
 * hijack routing from the running daemon and break every live session on it.
 * The precedent for reaching the daemon over loopback already exists — see
 * `registerDirectToken`, which POSTs to `127.0.0.1:{port}/_pair/session`.
 *
 * ## The guard
 *
 * Loopback-only plus the machine's own `AUTH_TOKEN`, compared in constant time.
 * Same shape as the relay's `localAdminOk`, and for the same reason: anything
 * that can drive this can approve a stranger's browser onto this machine.
 */

export const APPROVE_WAIT_PATH = "/_approve/wait";
export const APPROVE_DECIDE_PATH = "/_approve/decide";
export const APPROVE_STATE_PATH = "/_approve/state";

const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/**
 * How long a single request may sit in front of the approver.
 *
 * Under both bounds that matter: the broker's 120 s request TTL, and the TTY
 * prompt's own 110 s. A decision that arrives after the request has expired is
 * worse than no decision, because the human believes they approved something.
 */
export const OFFER_TIMEOUT_MS = 100_000;

/** Longest window a single `mtmux approve` may hold open. */
export const MAX_WINDOW_MS = 60 * 60_000;

export type ApprovalOffer = {
  sas: string;
  deviceLabel: string;
  accountEmail: string;
};

export type OfferOptions = {
  /**
   * Hold the request even though nobody is polling yet.
   *
   * For the case the old code failed hardest at: `mtmux start` under systemd,
   * `nohup`, or a detached tmux pane has no TTY and usually no open approval
   * window, so pressing "Pair this device" was denied instantly and silently
   * while the user was sitting right there. Parking gives them the offer
   * window to run `mtmux approve` in another shell, and `handleWait` flushes
   * whatever is already pending the moment they do.
   *
   * It still denies on timeout. Parking changes how long the question stands,
   * never the answer to silence.
   */
  park?: boolean;
  /**
   * Another channel answered — stop holding the slot.
   *
   * The in-app dialog and this window are raced (see `decideAccess`), and only
   * one of them wins. Without this the loser's request would keep the
   * one-at-a-time slot for the full offer timeout, so the *next* device to ask
   * would be refused outright for up to 100 seconds by a question that had
   * already been answered.
   *
   * It resolves the returned promise `false`. That is safe precisely because
   * the caller has by then discarded it: an abort is not a refusal reaching
   * anyone, it is a promise nobody is listening to any more.
   */
  signal?: AbortSignal;
};

export type ApproveState = {
  waiting: boolean;
  /** Epoch ms the window closes, or null when nobody is waiting. */
  expiresAt: number | null;
};

export type ApproveControlDeps = {
  /** The machine's `AUTH_TOKEN`. */
  authToken: string;
  now?: () => number;
  offerTimeoutMs?: number;
};

export type ApproveControl = {
  /** Returns true when it handled the request. Wire ahead of the relay. */
  handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean>;
  /**
   * Put a request in front of the waiting approver.
   *
   * `null` means **nobody is waiting** — the caller should fall through to the
   * TTY prompt. `false` means a human, or the absence of one, said no: refused,
   * timed out, or walked away. Those two are deliberately distinguishable,
   * because treating "no approver" as a refusal would stop `mtmux start` from
   * ever prompting in its own terminal.
   */
  offer(input: ApprovalOffer, opts?: OfferOptions): Promise<boolean | null>;
  state(): ApproveState;
  /** Drop the approver and fail anything pending. Called on shutdown. */
  close(): void;
};

type Waiter = {
  sessionId: string;
  expiresAt: number;
  /** The held long-poll response, when one is parked. */
  held: http.ServerResponse | null;
  timer: NodeJS.Timeout;
};

type Pending = {
  id: string;
  offer: ApprovalOffer;
  settle: (approved: boolean) => void;
  timer: NodeJS.Timeout;
};

export function createApproveControl(deps: ApproveControlDeps): ApproveControl {
  const now = deps.now ?? Date.now;
  const offerTimeoutMs = deps.offerTimeoutMs ?? OFFER_TIMEOUT_MS;

  let waiter: Waiter | null = null;
  let pending: Pending | null = null;
  let counter = 0;

  function settlePending(approved: boolean): void {
    if (!pending) return;
    const p = pending;
    pending = null;
    clearTimeout(p.timer);
    p.settle(approved);
  }

  function dropWaiter(): void {
    if (!waiter) return;
    const w = waiter;
    waiter = null;
    clearTimeout(w.timer);
    try {
      w.held?.end(JSON.stringify({ type: "closed" }));
    } catch {
      // Already gone.
    }
    // A request in front of an approver who has left is refused, never
    // approved. Silence is not consent — that is the whole reason `no-tty`
    // denies rather than waiting.
    settlePending(false);
  }

  function guard(req: http.IncomingMessage, res: http.ServerResponse): boolean {
    const peer = req.socket.remoteAddress ?? "";
    if (!LOOPBACK_ADDRESSES.has(peer)) {
      res.writeHead(403);
      res.end("Loopback only");
      return false;
    }
    const auth = req.headers.authorization;
    const bearer = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
    if (!bearer || !sameToken(bearer, deps.authToken)) {
      res.writeHead(401);
      res.end("Unauthorized");
      return false;
    }
    return true;
  }

  /** Hand the parked poll whatever is pending, if both exist. */
  function flush(): void {
    if (!waiter?.held || !pending) return;
    const held = waiter.held;
    waiter.held = null;
    send(held, 200, {
      type: "request",
      id: pending.id,
      sas: pending.offer.sas,
      deviceLabel: pending.offer.deviceLabel,
      accountEmail: pending.offer.accountEmail,
    });
  }

  async function handleWait(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const body = await readJson(req);
    const sessionId = String(body.sessionId ?? "");
    if (!sessionId) {
      send(res, 400, { error: "sessionId required" });
      return;
    }

    if (waiter && waiter.sessionId !== sessionId && waiter.expiresAt > now()) {
      // One approver at a time. Two windows would be two humans able to admit
      // the same browser, and only one of them would ever find out.
      send(res, 409, {
        error: "Another approval window is already open on this machine.",
        expiresAt: waiter.expiresAt,
      });
      return;
    }

    if (!waiter || waiter.sessionId !== sessionId) {
      const minutes = Number(body.minutes);
      const windowMs = Math.min(
        MAX_WINDOW_MS,
        Number.isFinite(minutes) && minutes > 0 ? minutes * 60_000 : 5 * 60_000,
      );
      const expiresAt = now() + windowMs;
      const timer = setTimeout(dropWaiter, windowMs);
      timer.unref?.();
      waiter = { sessionId, expiresAt, held: null, timer };
    }

    // Park the response. Anything already pending goes out immediately, which
    // is what makes `--keep`'s re-poll race-free: a request that arrived
    // between polls is still here waiting.
    waiter.held = res;
    res.on("close", () => {
      if (waiter?.held === res) {
        waiter.held = null;
        // The poll ending is not the window ending — `--keep` re-polls. But a
        // request already in front of this approver has lost its audience.
        settlePending(false);
      }
    });
    flush();
  }

  async function handleDecide(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const body = await readJson(req);
    if (!waiter || waiter.sessionId !== String(body.sessionId ?? "")) {
      send(res, 409, { error: "No approval window is open." });
      return;
    }
    if (!pending || pending.id !== String(body.id ?? "")) {
      send(res, 409, { error: "That request is no longer waiting." });
      return;
    }
    // Explicit true only. A malformed body, a missing field or anything
    // truthy-but-not-true is a refusal.
    settlePending(body.approved === true);
    send(res, 200, { ok: true });
  }

  return {
    async handle(req, res) {
      const url = (req.url ?? "").split("?")[0];
      if (
        url !== APPROVE_WAIT_PATH &&
        url !== APPROVE_DECIDE_PATH &&
        url !== APPROVE_STATE_PATH
      ) {
        return false;
      }
      if (!guard(req, res)) return true;

      try {
        if (url === APPROVE_STATE_PATH) {
          const open = waiter !== null && waiter.expiresAt > now();
          send(res, 200, {
            waiting: open,
            expiresAt: open ? waiter!.expiresAt : null,
          });
          return true;
        }
        if (url === APPROVE_WAIT_PATH) {
          await handleWait(req, res);
          return true;
        }
        await handleDecide(req, res);
        return true;
      } catch {
        if (!res.headersSent) send(res, 400, { error: "Bad request" });
        return true;
      }
    },

    offer(input, opts = {}) {
      const open = waiter !== null && waiter.expiresAt > now();
      // `null` means "nobody is waiting, ask someone else" — the caller falls
      // through to the TTY prompt. With `park` there is nobody else to ask.
      if (!open && !opts.park) return Promise.resolve(null);
      // One at a time, matching the broker's own one-live-request-per-device
      // rule. A second offer while one is in front of a human is refused rather
      // than queued behind it, because it would expire before its turn came.
      if (pending) return Promise.resolve(false);

      if (opts.signal?.aborted) return Promise.resolve(false);

      return new Promise<boolean>((resolve) => {
        const id = `off-${(counter += 1).toString(36)}`;
        const timer = setTimeout(() => settlePending(false), offerTimeoutMs);
        timer.unref?.();
        const signal = opts.signal;
        const onAbort = signal
          ? () => {
              // Only if it is still *this* request in the slot. A late abort
              // must not settle somebody else's question.
              if (pending?.id === id) settlePending(false);
            }
          : null;
        if (signal && onAbort) signal.addEventListener("abort", onAbort);
        const settle = (approved: boolean): void => {
          if (signal && onAbort) signal.removeEventListener("abort", onAbort);
          resolve(approved);
        };
        pending = { id, offer: input, settle, timer };
        flush();
      });
    },

    state() {
      const open = waiter !== null && waiter.expiresAt > now();
      return { waiting: open, expiresAt: open ? waiter!.expiresAt : null };
    },

    close() {
      dropWaiter();
    },
  };
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  if (res.writableEnded) return;
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readJson(
  req: http.IncomingMessage,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    // A control endpoint has no business receiving anything large, and an
    // unbounded read on a loopback socket is still an unbounded read.
    if (size > 16 * 1024) throw new Error("body too large");
    chunks.push(buf);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<
    string,
    unknown
  >;
}

/**
 * Constant-time compare, tolerating different lengths.
 *
 * `timingSafeEqual` throws when the buffers differ in size, and the naive fix —
 * an early length check — leaks the length. Hashing both to a fixed width
 * before comparing is the usual answer; here the simpler one is enough because
 * both sides are the same 64-hex token whenever the caller is legitimate, and a
 * length mismatch is a wrong token either way. Copied in shape from the relay's
 * `timingSafeEqualToken` rather than imported, because the CLI must not depend
 * on the relay package's internals.
 */
function sameToken(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) {
    // Still compare, so the work done does not depend on where they differ.
    timingSafeEqual(left, left);
    return false;
  }
  return timingSafeEqual(left, right);
}
