import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { createLogger } from "@repo/logger";
import { config } from "./config.js";
import { isPathAllowed } from "./file-service.js";
import { getMimeType } from "./mime.js";
import { timingSafeEqualToken } from "./auth.js";
import {
  checkAuthThrottle,
  recordAuthFailure,
  recordAuthSuccess,
} from "./auth-throttle.js";
import {
  redeemLocalPairing,
  registerSessionToken,
  grantForToken,
  revokeGrant,
} from "./pairing-local.js";
import { allowsRecording, FULL_GRANT } from "./grant.js";
import * as recordings from "./recordings-index.js";
import { broadcastToAll } from "./connection-manager.js";
import { isCloneSession } from "./tmux-clone.js";
import { listSessions } from "./tmux-manager.js";
import { GrantRecord, sanitizeLabel } from "@repo/protocol";

const logger = createLogger("relay:http");

/**
 * Redeems the one-time credential from the startup banner — the QR's nonce or
 * the six digits under it — for a scoped session token.
 *
 * POST rather than the more obvious `GET /_pair/local?n=…`: a query string ends
 * up in access logs, shell history and `Referer` headers, and this one carries
 * a live credential. The body does not.
 */
export const PAIR_LOCAL_PATH = "/_pair/local";

const MAX_PAIR_BODY_BYTES = 1024;

function readBody(req: http.IncomingMessage): Promise<string | null> {
  return new Promise((resolve) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_PAIR_BODY_BYTES) {
        resolve(null);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", () => resolve(null));
  });
}

async function handleLocalPairing(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<boolean> {
  if (req.method !== "POST") {
    res.writeHead(405, { Allow: "POST" });
    res.end("Method not allowed");
    return true;
  }

  /*
   * `application/json`, required — which is a CSRF control, not a parser
   * nicety.
   *
   * A cross-origin `fetch` with a JSON content type is not a "simple request",
   * so the browser must preflight it and this origin never answers a
   * preflight. With any content type accepted, a page on the open internet
   * could POST here from the browser of anybody sitting on this wifi. It could
   * not *read* the answer — no CORS headers come back — so it could never
   * steal a session token. What it could do is spend guesses and burn the code
   * on screen, over and over, from a tab the victim does not know is open.
   */
  const contentType = (req.headers["content-type"] ?? "").split(";")[0]!.trim();
  if (contentType.toLowerCase() !== "application/json") {
    res.writeHead(415, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Expected application/json" }));
    return true;
  }

  /*
   * The same per-address backoff that guards token authentication, and for the
   * same reason.
   *
   * The six-digit code has a five-guess budget of its own, after which it
   * burns and the terminal prints a fresh one — which on its own is not a
   * bound at all, because the attacker simply keeps going against the new
   * code. Five guesses per re-arm over a million codes is a few hours of
   * requests. With this in front, an address gets roughly five attempts per
   * quarter hour, and the same search is measured in centuries.
   *
   * Shared deliberately with `authenticateMessage`: somebody guessing pairing
   * codes on this network has no business getting a fresh token-guessing
   * budget by switching ports.
   */
  const address = req.socket.remoteAddress ?? null;
  const throttled = checkAuthThrottle(address);
  if (!throttled.allowed) {
    res.writeHead(429, {
      "Content-Type": "application/json",
      "Retry-After": String(Math.ceil(throttled.retryAfterMs / 1000)),
    });
    res.end(JSON.stringify({ error: "Too many attempts" }));
    return true;
  }

  const raw = await readBody(req);
  let body: { nonce?: unknown; code?: unknown; label?: unknown } = {};
  try {
    if (raw) body = JSON.parse(raw) as typeof body;
  } catch {
    body = {};
  }

  const nonce = typeof body.nonce === "string" ? body.nonce : "";
  const code = typeof body.code === "string" ? body.code : "";
  if (!nonce && !code) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Missing nonce or code" }));
    return true;
  }

  /*
   * A self-reported name, carried so the person at the machine is asked about
   * "iPhone · Safari" rather than about an anonymous request. It decides
   * nothing — see `LocalPairingRequest` — and it is length-capped here because
   * it is the one field in this request that reaches a human's screen.
   */
  const label =
    typeof body.label === "string" ? sanitizeLabel(body.label, 80) : "";

  const result = await redeemLocalPairing({ nonce, code }, { label });

  // A refusal is not a failed guess — the credential was right — so it does
  // not feed the backoff. Billing it would let somebody lock their own laptop
  // out of pairing by pressing "no" twice.
  if (!result.ok && result.reason === "refused") {
    // Said plainly, and distinct from 401 on purpose: the credential was
    // right and a human said no. Telling that person "invalid or already
    // used" would send them looking for a typo that does not exist.
    logger.warn("Local pairing refused at the machine");
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Refused at the machine" }));
    return true;
  }

  if (!result.ok) {
    recordAuthFailure(address);
    // Deliberately vague and deliberately unlogged — no credential material,
    // and no signal about whether this code never existed or was already spent.
    logger.warn("Local pairing rejected");
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({ error: "Pairing code is invalid or already used" }),
    );
    return true;
  }

  recordAuthSuccess(address);
  logger.info("Local pairing succeeded — session token issued");
  res.writeHead(200, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  res.end(
    JSON.stringify({
      token: result.session.token,
      expiresAt: result.session.expiresAt,
    }),
  );
  return true;
}

/**
 * Registers a session token derived by `mtmux pair` in another process.
 *
 * Loopback-only and authenticated with the machine's own AUTH_TOKEN, because
 * the caller is the CLI on this host. This is what lets the browser
 * authenticate on the *direct* path using a token both sides computed from the
 * pairing key — so the 64-hex AUTH_TOKEN never has to be sent to the device.
 */
export const PAIR_SESSION_PATH = "/_pair/session";

const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

async function handleSessionRegistration(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<boolean> {
  if (req.method !== "POST") {
    res.writeHead(405, { Allow: "POST" });
    res.end("Method not allowed");
    return true;
  }

  // Even with the token, refuse this from off-box: it mints credentials.
  const peer = req.socket.remoteAddress ?? "";
  if (!LOOPBACK_ADDRESSES.has(peer)) {
    res.writeHead(403);
    res.end("Loopback only");
    return true;
  }

  const auth = req.headers.authorization;
  const bearer = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!bearer || !timingSafeEqualToken(bearer, config.authToken)) {
    res.writeHead(401);
    res.end("Unauthorized");
    return true;
  }

  const raw = await readBody(req);
  let body: {
    token?: unknown;
    ttlMs?: unknown;
    deviceId?: unknown;
    grant?: unknown;
    label?: unknown;
    via?: unknown;
  } = {};
  try {
    body = raw ? (JSON.parse(raw) as typeof body) : {};
  } catch {
    body = {};
  }

  if (typeof body.token !== "string" || body.token.length < 32) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Missing token" }));
    return true;
  }

  /**
   * An optional scope for the token being registered.
   *
   * Absent means the full grant, which is what every existing caller sends and
   * what a plain `mtmux start` pairing has always meant. `mtmux share` is the
   * only caller that supplies one.
   *
   * Parsed rather than trusted: this arrives over loopback from a process
   * holding `AUTH_TOKEN`, so it is not an attack surface, but a malformed
   * grant that silently became the full grant would turn a typo in the share
   * command into a full-machine share.
   */
  let grant = FULL_GRANT;
  if (body.grant !== undefined) {
    const parsed = GrantRecord.safeParse(body.grant);
    if (!parsed.success) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Malformed grant" }));
      return true;
    }
    grant = parsed.data;
  }

  /*
   * A supplied lifetime must be usable, or the request is a mistake.
   *
   * This used to fall back to the 24 h default whenever `ttlMs` was not a
   * positive number — including when it was exactly `0`, which is what a peer
   * record on the last instant of its life produces. Silently substituting a
   * shorter window is precisely the bug this endpoint's callers were changed to
   * avoid, and it fails open: the caller believes it asked for 90 days and got
   * a day. Absent still means "use the default"; present and unusable is a 400.
   */
  if (
    body.ttlMs !== undefined &&
    (typeof body.ttlMs !== "number" ||
      !Number.isFinite(body.ttlMs) ||
      body.ttlMs <= 0)
  ) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "ttlMs must be a positive number" }));
    return true;
  }
  const ttlMs = typeof body.ttlMs === "number" ? body.ttlMs : undefined;
  const label =
    typeof body.label === "string" && body.label.length > 0
      ? body.label.slice(0, 128)
      : undefined;
  // Names a peer record in the CLI's config so `onSessionTokenUsed` can report
  // that this device is still in use. Never used to decide anything.
  const deviceId =
    typeof body.deviceId === "string" && body.deviceId.length > 0
      ? body.deviceId.slice(0, 128)
      : undefined;
  const session = registerSessionToken(
    body.token,
    ttlMs,
    undefined,
    grant,
    label,
    deviceId,
  );
  logger.info(
    { grant: grant.id, readOnly: grant.readOnly, files: grant.files },
    "Session token registered for a paired device",
  );

  /**
   * Tell everyone already connected that another device just got in.
   *
   * Pairing is otherwise only ever visible on the machine's own screen, so a
   * browser holding a live session had no way to learn a second device had been
   * admitted — the one event a user most wants to hear about, and the one an
   * attacker most wants kept quiet. It carries a coarse label and nothing else.
   */
  broadcastToAll({
    type: "device:paired",
    label: label ?? "A device",
    via: body.via === "request" ? "request" : "code",
    at: Date.now(),
  });
  res.writeHead(200, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify({ expiresAt: session.expiresAt }));
  return true;
}

/**
 * Cut a grant off immediately, rather than at the session token's own TTL.
 *
 * `mtmux share revoke` writes `grants.json` first — that file is the record of
 * truth and survives a restart — and then calls this so the revocation takes
 * effect on a live server without waiting for one.
 */
export const PAIR_REVOKE_PATH = "/_pair/revoke";

/**
 * The session list, for `mtmux share` to pin ids against.
 *
 * A grant names sessions by tmux `session_id`, and the sharing process is not
 * the one holding the tmux connection — so it has to ask. Loopback-only and
 * `AUTH_TOKEN`-authenticated like the other two, because a list of session
 * names is exactly the thing this product does not hand out.
 */
export const SESSIONS_PATH = "/_sessions";

/** Shared guard: loopback only, and the machine's own token. */
function localAdminOk(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): boolean {
  const peer = req.socket.remoteAddress ?? "";
  if (!LOOPBACK_ADDRESSES.has(peer)) {
    res.writeHead(403);
    res.end("Loopback only");
    return false;
  }
  const auth = req.headers.authorization;
  const bearer = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!bearer || !timingSafeEqualToken(bearer, config.authToken)) {
    res.writeHead(401);
    res.end("Unauthorized");
    return false;
  }
  return true;
}

async function handleGrantRevocation(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<boolean> {
  if (req.method !== "POST") {
    res.writeHead(405, { Allow: "POST" });
    res.end("Method not allowed");
    return true;
  }
  if (!localAdminOk(req, res)) return true;

  const raw = await readBody(req);
  let body: { grantId?: unknown } = {};
  try {
    body = raw ? (JSON.parse(raw) as typeof body) : {};
  } catch {
    body = {};
  }
  if (typeof body.grantId !== "string" || body.grantId.length === 0) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Missing grantId" }));
    return true;
  }

  const removed = revokeGrant(body.grantId);
  logger.info({ grant: body.grantId, removed }, "Grant revoked");
  res.writeHead(200, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify({ removed }));
  return true;
}

async function handleSessionListing(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<boolean> {
  if (req.method !== "GET") {
    res.writeHead(405, { Allow: "GET" });
    res.end("Method not allowed");
    return true;
  }
  if (!localAdminOk(req, res)) return true;

  const sessions = (await listSessions())
    .filter((s) => !isCloneSession(s.name))
    .map((s) => ({ id: s.id, name: s.name }));

  res.writeHead(200, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify({ sessions }));
  return true;
}

// Matches HTTP header-unsafe characters (C0 controls, DEL, double-quote,
// backslash) used to sanitize the Content-Disposition ASCII filename fallback.
// eslint-disable-next-line no-control-regex
const UNSAFE_HEADER_CHARS = /[\u0000-\u001f\u007f"\\]/g;

/**
 * Returns the relay's request handler for `/health` and `/file?...`. Returns
 * `true` if the request was handled (caller must not respond), `false` if the
 * caller should fall through to its own handler (e.g. Next.js).
 */
export async function handleRelayRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<boolean> {
  const origin = req.headers.origin;
  if (origin && config.corsOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  }

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return true;
  }

  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", uptime: process.uptime() }));
    return true;
  }

  if (req.url === PAIR_LOCAL_PATH) {
    return handleLocalPairing(req, res);
  }

  if (req.url === PAIR_SESSION_PATH) {
    return handleSessionRegistration(req, res);
  }

  if (req.url === PAIR_REVOKE_PATH) {
    return handleGrantRevocation(req, res);
  }

  if (req.url === SESSIONS_PATH) {
    return handleSessionListing(req, res);
  }

  if (req.url?.startsWith("/recording?") && req.method === "GET") {
    return handleRecordingDownload(req, res, origin);
  }

  if (req.url?.startsWith("/file?") && req.method === "GET") {
    // Echo the request Origin only when allow-listed (never a blanket `*`).
    if (origin && config.corsOrigins.includes(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
    }
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization",
    );

    const url = new URL(req.url, `http://${req.headers.host}`);
    const filePath = url.searchParams.get("path");
    // `Authorization: Bearer <token>` is the only path this app uses. The
    // `?token=` query param is deprecated and kept purely for older clients:
    // the credential is the session's own 256-bit token, and a query string
    // puts it in browser history, `Referer` headers and every access log in
    // between. Logged when used, so its remaining traffic is visible.
    const authHeader = req.headers.authorization;
    const bearerToken = authHeader?.startsWith("Bearer ")
      ? authHeader.slice("Bearer ".length)
      : null;
    const queryToken = url.searchParams.get("token");
    if (!bearerToken && queryToken) {
      logger.warn(
        "Deprecated ?token= used on /file; send Authorization: Bearer instead",
      );
    }
    const token = bearerToken ?? queryToken;
    const download = url.searchParams.get("download") === "1";

    // Either the long-lived token or a scoped session token from pairing —
    // otherwise a paired device could read the terminal but not open a file.
    const grant =
      token === null
        ? null
        : timingSafeEqualToken(token, config.authToken)
          ? FULL_GRANT
          : grantForToken(token);
    if (!grant) {
      res.writeHead(401);
      res.end("Unauthorized");
      return true;
    }

    // The same hole as `file:*` on the WebSocket, but outside it: this
    // endpoint accepted any valid session token and checked only
    // `isPathAllowed`, so a share with file access explicitly off could still
    // read any file under ALLOWED_PATHS by asking over HTTP instead.
    if (grant.files === "none") {
      res.writeHead(403);
      res.end("File access is not part of this share");
      return true;
    }

    if (!filePath) {
      res.writeHead(400);
      res.end("Missing path parameter");
      return true;
    }

    if (!isPathAllowed(filePath)) {
      res.writeHead(403);
      res.end("Access denied");
      return true;
    }

    try {
      const resolved = path.resolve(filePath);
      const stat = await fsp.stat(resolved);
      if (!stat.isFile()) {
        res.writeHead(404);
        res.end("Not a file");
        return true;
      }

      const mime = getMimeType(resolved);
      const fileName = path.basename(resolved);
      const headers: Record<string, string> = {
        "Content-Type": mime,
        "Cache-Control": "private, max-age=60",
      };

      if (download) {
        // Strip header-unsafe chars from the ASCII fallback to prevent header
        // injection / breaking out of the quoted-string, and additionally
        // provide an RFC 5987 UTF-8 encoded filename for non-ASCII names.
        const safeName = fileName.replace(UNSAFE_HEADER_CHARS, "_");
        const encodedName = encodeURIComponent(fileName);
        headers["Content-Disposition"] =
          `attachment; filename="${safeName}"; filename*=UTF-8''${encodedName}`;
      }

      const rangeHeader = req.headers.range;
      if (rangeHeader) {
        const match = /bytes=(\d+)-(\d*)/.exec(rangeHeader);
        if (match) {
          const start = parseInt(match[1]!, 10);
          const end = match[2] ? parseInt(match[2], 10) : stat.size - 1;
          if (start >= stat.size) {
            res.writeHead(416, { "Content-Range": `bytes */${stat.size}` });
            res.end();
            return true;
          }
          const clampedEnd = Math.min(end, stat.size - 1);
          headers["Content-Range"] =
            `bytes ${start}-${clampedEnd}/${stat.size}`;
          headers["Content-Length"] = String(clampedEnd - start + 1);
          headers["Accept-Ranges"] = "bytes";
          res.writeHead(206, headers);
          fs.createReadStream(resolved, { start, end: clampedEnd }).pipe(res);
          return true;
        }
      }

      headers["Content-Length"] = String(stat.size);
      headers["Accept-Ranges"] = "bytes";
      res.writeHead(200, headers);
      fs.createReadStream(resolved).pipe(res);
    } catch (err) {
      logger.error({ err, path: filePath }, "File serve error");
      res.writeHead(404);
      res.end("File not found");
    }
    return true;
  }

  return false;
}

/**
 * `GET /recording?id=rec_…` — a LAN-only fast path, and nothing more.
 *
 * The mechanism for handing somebody a recording is `recording:fetch` over the
 * websocket, because the case this feature exists for is a phone on cellular,
 * which is the *tunnelled* case: there the relay is reachable only as sealed
 * frames through the broker and the web app's `resolveRelayHttpBase()` returns
 * `""`. This route exists because on a LAN a plain HTTP GET is faster and lets
 * the browser stream, and for no other reason.
 *
 * **It takes an `id` and has no `path` parameter at all.** That is precisely
 * what stops it becoming `/file` with extra steps: the only files it can serve
 * are ones this relay itself wrote and indexed, and the caller cannot name one
 * that is not in the index. Note also what it does *not* consult: `grant.files`
 * is irrelevant here, because a recording is not a file in the allow-listed
 * tree — a recordings-scoped share deliberately carries `files: "none"`.
 */
async function handleRecordingDownload(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  origin: string | undefined,
): Promise<boolean> {
  if (origin && config.corsOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith("Bearer ")
    ? authHeader.slice("Bearer ".length)
    : null;

  const grant =
    token === null
      ? null
      : timingSafeEqualToken(token, config.authToken)
        ? FULL_GRANT
        : grantForToken(token);
  if (!grant) {
    res.writeHead(401);
    res.end("Unauthorized");
    return true;
  }

  const id = url.searchParams.get("id");
  // "Not found" for out of scope as well as absent — the same rule the
  // websocket path follows, and for the same reason: two different answers is
  // an oracle for enumerating recording ids.
  const recording =
    id && allowsRecording(grant, id) ? await recordings.get(id) : null;
  if (!recording) {
    res.writeHead(404);
    res.end("Recording not found");
    return true;
  }

  const resolved = recordings.recordingPath(recording.filename);
  try {
    const stat = await fsp.stat(resolved);
    res.writeHead(200, {
      "Content-Type": "application/x-asciicast",
      "Content-Length": String(stat.size),
      "Cache-Control": "private, no-store",
      "Content-Disposition": `attachment; filename="${recording.id}.cast"`,
    });
    fs.createReadStream(resolved).pipe(res);
  } catch (err) {
    logger.error({ err, id: recording.id }, "Recording serve error");
    res.writeHead(404);
    res.end("Recording not found");
  }
  return true;
}

export function createHttpServer() {
  return http.createServer(async (req, res) => {
    const handled = await handleRelayRequest(req, res);
    if (!handled) {
      res.writeHead(404);
      res.end("Not found");
    }
  });
}

export function startHttpServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    server.listen(config.port, config.host, () => {
      logger.info(`HTTP server listening on ${config.host}:${config.port}`);
      resolve();
    });
  });
}
