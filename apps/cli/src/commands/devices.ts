import kleur from "kleur";
import * as configStore from "../config-store.js";
import * as serverState from "../server-state.js";
import { DEVICES_REVOKE_PATH } from "../devices-control.js";
import { readAccessLog, ACCESS_LOG_PATH } from "../access-log.js";
import { displayLabel } from "@repo/protocol";

/**
 * Browsers this machine has paired with.
 *
 * These are local records, not account records: a device is trusted by *this
 * server*, and revoking it here is what actually stops it reconnecting. The
 * dashboard shows the same list for signed-in users, but this command is the
 * one that works with no account and no network.
 */

function ago(at: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/**
 * Who has actually connected, from the relay's own append-only record.
 *
 * `mtmux devices` answers "who *may* connect"; this answers "who did". They
 * are different questions, and until now only the first had an answer — a
 * device that authenticated, looked around and left showed up nowhere at all.
 */
export async function devicesHistory(
  opts: { limit?: number } = {},
): Promise<void> {
  const events = await readAccessLog();
  if (events.length === 0) {
    console.log("");
    console.log(kleur.dim("  Nothing has connected to this machine yet."));
    console.log(
      kleur.dim("  The log starts at ") + kleur.bold(ACCESS_LOG_PATH) + ".",
    );
    console.log("");
    return;
  }

  const limit = opts.limit ?? 50;
  const shown = events.slice(-limit);
  console.log("");
  for (const e of shown) {
    const when = new Date(e.at);
    const stamp = Number.isNaN(when.getTime()) ? e.at : when.toLocaleString();
    const mark = e.event === "connected" ? kleur.green("→") : kleur.dim("←");
    const scope =
      e.scope === "all" && !e.readOnly && e.files !== "none"
        ? "full"
        : [e.scope, e.readOnly ? "read-only" : null, `files:${e.files}`]
            .filter(Boolean)
            .join(" ");
    const tail =
      e.event === "disconnected" && e.seconds !== undefined
        ? kleur.dim(`  (${e.seconds}s)`)
        : "";
    console.log(
      `  ${mark} ${kleur.dim(stamp)}  ${displayLabel(e.label, "unknown device")}` +
        `  ${kleur.dim(`${e.transport} · ${scope}`)}${tail}`,
    );
  }
  console.log("");
  if (events.length > shown.length) {
    console.log(
      kleur.dim(`  ${events.length - shown.length} older entries in `) +
        kleur.bold(ACCESS_LOG_PATH),
    );
    console.log("");
  }
}

export async function devicesList(): Promise<void> {
  const peers = await configStore.listPeers();
  if (peers.length === 0) {
    console.log("");
    console.log(kleur.dim("  No devices paired with this machine yet."));
    console.log(
      kleur.dim("  Run ") +
        kleur.bold("mtmux") +
        kleur.dim(" and scan the code."),
    );
    console.log("");
    return;
  }

  // `displayLabel` rather than the raw field: a peer-supplied label reaching
  // a terminal unstripped is the defect `sanitizeLabel`'s header describes,
  // and this command prints one per row.
  const named = peers.map((peer) => ({
    peer,
    shown: displayLabel(configStore.displayName(peer), "unknown device"),
  }));
  const labelWidth = Math.max(...named.map((n) => n.shown.length), 6);
  console.log("");
  for (const { peer, shown } of named) {
    const stale = configStore.isPeerExpired(peer);
    const dot = stale ? kleur.dim("○") : kleur.green("●");
    console.log(
      `  ${dot} ${shown.padEnd(labelWidth)}  ${kleur.dim(ago(peer.lastSeenAt))}` +
        `  ${kleur.dim(peer.deviceId)}` +
        // Only when a rename has made the two differ. Printing the browser's
        // own claim beside an identical name is a column of noise.
        (peer.name && peer.label && peer.label !== shown
          ? kleur.dim(`  (${displayLabel(peer.label, "unnamed")})`)
          : "") +
        (stale ? kleur.dim("  (stale)") : ""),
    );
  }
  console.log("");
  console.log(
    kleur.dim("  Name one with  ") +
      kleur.bold("mtmux devices rename <id> <name>"),
  );
  console.log(
    kleur.dim("  Revoke one with ") + kleur.bold("mtmux devices revoke <id>"),
  );
  console.log("");
}

/**
 * Give a device a name of your own.
 *
 * The same thing `e` does in the live panel, for a machine whose panel is not
 * up — a service unit, a pipe, an SSH session with no tty. Passing no name
 * clears it back to whatever the browser calls itself, which is the only way
 * back and is therefore worth having a spelling for.
 */
export async function devicesRename(
  deviceId: string,
  parts: string[],
): Promise<void> {
  const name = parts.join(" ").trim();
  const ok = await configStore.renamePeer(deviceId, name || null);
  if (!ok) {
    console.error(kleur.red(`✗ No device with id ${deviceId}.`));
    console.error(kleur.dim("  Run `mtmux devices` to see the list."));
    process.exitCode = 1;
    return;
  }
  console.log(
    name
      ? kleur.green(`✓ Now called ${name}.`)
      : kleur.green("✓ Name cleared — back to what the browser calls it."),
  );
  console.log(kleur.dim("  It changes nothing about what that device may do."));
}

/**
 * Tell a running server to forget the token too.
 *
 * The peer record is only what the *next* boot restores from; the live relay
 * holds its own in-memory copy with a sliding ninety-day window that the
 * revoked device's own traffic keeps renewing. Best-effort by nature — there
 * may be no server running, and revoking the record is still the right thing to
 * do when there isn't.
 */
async function revokeOnRunningServer(token: string): Promise<boolean> {
  const state = await serverState.read();
  if (!state) return false;
  try {
    const cfg = await configStore.load();
    const res = await fetch(
      `http://127.0.0.1:${state.port}${DEVICES_REVOKE_PATH}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${cfg.token}`,
        },
        body: JSON.stringify({ token }),
        signal: AbortSignal.timeout(3000),
      },
    );
    if (!res.ok) return false;
    const body = (await res.json()) as { applied?: boolean };
    return body.applied === true;
  } catch {
    return false;
  }
}

export async function devicesRevoke(deviceId: string): Promise<void> {
  // Read before removing: the peer record is where the token lives, and the
  // running relay needs it to drop the live session.
  const peer = (await configStore.listPeers()).find(
    (p) => p.deviceId === deviceId,
  );
  const removed = await configStore.removePeer(deviceId);
  if (!removed) {
    console.error(kleur.red(`✗ No device with id ${deviceId}.`));
    console.error(kleur.dim("  Run `mtmux devices` to see the list."));
    process.exitCode = 1;
    return;
  }

  const dropped = peer?.directToken
    ? await revokeOnRunningServer(peer.directToken)
    : false;

  console.log(kleur.green("✓ Revoked."));
  console.log(
    dropped
      ? kleur.dim("  Its session is gone and it can no longer reconnect.")
      : // Still said out loud when it could not be applied, because the
        // difference matters: an attached browser keeps its live socket.
        kleur.dim(
          "  It can no longer reconnect. Restart mtmux to drop it now.",
        ),
  );
}
