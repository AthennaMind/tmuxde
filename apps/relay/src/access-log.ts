import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { appendFile, mkdir, chmod, readFile } from "node:fs/promises";
import { createLogger } from "@repo/logger";
import type { GrantRecord } from "@repo/protocol";
import { isFullGrant } from "./grant.js";

/**
 * Who connected to this machine, and what they were allowed to do.
 *
 * There was no audit trail at all: a device that authenticated, read
 * `~/.ssh/id_rsa` and left produced one line naming a grant id, and successful
 * file reads were not recorded anywhere. "Did anything happen while I was
 * away" had no answer, which is a strange gap in a product whose whole promise
 * is that you can leave a shell exposed and still be in control of it.
 *
 * Deliberately narrow. This records *authentication and disconnection*, not
 * activity: one line when a credential is admitted and one when its socket
 * goes. Logging keystrokes or file paths would make the audit trail a more
 * attractive target than the thing it audits, and the machine's owner already
 * has the terminal's own history for that.
 *
 * NDJSON, append-only, 0600, in the same directory as the config it describes.
 * Writes are fire-and-forget: a full disk must never be able to refuse someone
 * access to their own machine.
 */

/**
 * Resolved per call, not at import.
 *
 * Every other store in the relay pins its path at module load, which is fine
 * for them because they are constructed after the process is configured. This
 * one is reached from the connection handler, and resolving it late costs a
 * `join` per pairing while making the module honest about an env var that can
 * be set by an embedding CLI at any point before the first connection.
 */
export function accessLogPath(): string {
  const dir = process.env.MTMUX_CONFIG_DIR ?? join(homedir(), ".mtmux");
  return join(dir, "access.log");
}

/** How a device reached the relay. Not self-reported — the relay knows. */
export type AccessTransport = "loopback" | "lan" | "tunnel";

export type AccessEvent = {
  /** ISO-8601, so the file is readable without the CLI. */
  at: string;
  /**
   * `refused` is a socket that had a valid credential and was still not let
   * in — the gate in `connection-gate.ts` said no, or nobody was there to say
   * yes. Worth a line of its own: it is the difference between "somebody
   * guessed a token" and "somebody is holding a token they should not have".
   */
  event: "connected" | "disconnected" | "refused";
  /** Which credential. `null` for the machine's own `AUTH_TOKEN`. */
  grantId: string | null;
  /** "all" for a full grant, otherwise the share's scope kind. */
  scope: string;
  readOnly: boolean;
  /** "none", "read" or "write". */
  files: string;
  label: string | null;
  transport: AccessTransport;
  /** Present on a disconnect: how long the socket lived, in seconds. */
  seconds?: number;
};

/**
 * The user-agent the tunnel agent sets on its loopback socket.
 *
 * A tunnelled browser reaches the relay *through* that agent, so its peer
 * address is 127.0.0.1 and indistinguishable from a local one by address
 * alone. This header is set by our own code on the same machine — it is a
 * label, not a credential, and nothing is authorised by it.
 */
const TUNNEL_AGENT_UA = "mtmux-tunnel-agent";

export function transportFor(
  remoteAddress: string | null,
  userAgent?: string | null,
): AccessTransport {
  if (userAgent === TUNNEL_AGENT_UA) return "tunnel";
  if (!remoteAddress) return "loopback";
  const ip = remoteAddress.replace(/^::ffff:/, "");
  if (ip === "127.0.0.1" || ip === "::1" || ip === "localhost")
    return "loopback";
  return "lan";
}

export function describeGrant(grant: GrantRecord): {
  grantId: string | null;
  scope: string;
  readOnly: boolean;
  files: string;
} {
  return {
    grantId: isFullGrant(grant) ? null : grant.id,
    scope: isFullGrant(grant) ? "all" : grant.scope.kind,
    readOnly: Boolean(grant.readOnly),
    files: grant.files ?? "none",
  };
}

const logger = createLogger("relay:access-log");

let warned = false;

/**
 * Append one event.
 *
 * Never throws and never awaited by a request path. The alternative — letting
 * an unwritable log deny a connection — trades a missing audit line for a
 * locked-out user, which is the wrong way round for a tool whose failure mode
 * is someone stranded away from their machine.
 */
export async function record(
  event: AccessEvent,
  path: string = accessLogPath(),
): Promise<void> {
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await appendFile(path, `${JSON.stringify(event)}\n`, { mode: 0o600 });
    await chmod(path, 0o600);
  } catch (err) {
    // Once, not per connection: a read-only home directory would otherwise
    // turn every pairing into a log line about logging.
    if (!warned) {
      warned = true;
      logger.warn({ err }, "Could not write the access log");
    }
  }
}

/** Read the log back, newest last. Used by `mtmux devices --history`. */
export async function readAccessLog(
  path: string = accessLogPath(),
): Promise<AccessEvent[]> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return [];
  }
  const events: AccessEvent[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line) as AccessEvent);
    } catch {
      // A truncated final line is what a `kill -9` mid-append leaves. Skip it
      // rather than refusing to show the ninety lines that are intact.
    }
  }
  return events;
}

/** Test seam — the module remembers whether it has already complained. */
export function resetAccessLogWarning(): void {
  warned = false;
}
