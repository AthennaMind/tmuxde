import type { RelayClient } from "./ws-client";

/**
 * Which relay client belongs to which machine.
 *
 * This replaces `let globalClient: RelayClient | null`, which encoded an
 * assumption that stopped being true the moment the dashboard had to answer
 * "what is running everywhere": one browser, one relay, forever. The terminal
 * still only ever drives one connection, so the singleton was never *wrong* —
 * it was just the only place a second connection could have gone.
 *
 * Two things the map alone would not give us:
 *
 * 1. **Refcounting.** React mounts an effect, tears it down and mounts it again
 *    under StrictMode, and route changes overlap. A plain `set`/`delete` pair
 *    means the teardown of the *old* mount closes the socket the *new* one just
 *    opened. Counting holders makes acquire/release idempotent in the way the
 *    callers already assume.
 * 2. **An active server.** Every terminal call site asks "the client", not "the
 *    client for machine X", and rewriting twenty-odd of them to thread a server
 *    id would be churn with no behaviour change. `getActive()` keeps
 *    `getRelayClient()` a one-line shim, and the id is set in exactly one place
 *    — the hook that opened the connection.
 *
 * Nothing here talks to the network. It hands out clients and counts holders;
 * connect/disconnect stay entirely inside `RelayClient`.
 */

/**
 * The id used when there is no pairing at all — the self-hosted and split
 * deployments, where the relay is simply "this origin" and there is no device
 * fingerprint to key on.
 */
export const LOCAL_SERVER_ID = "local";

type Entry = {
  client: RelayClient;
  refs: number;
  /**
   * Fingerprint of what the client was built from (url + token + transport).
   * A holder that acquires the same machine with different connection details
   * — a direct candidate that has just gone away, say — gets a fresh client
   * rather than the stale one, without disturbing the refcount.
   */
  key: string;
};

const entries = new Map<string, Entry>();
let active: string | null = null;

/**
 * Take a reference to the client for `serverId`, creating it if needed.
 *
 * `create` is called only when there is nothing usable to hand back, so a
 * second caller never opens a second socket to the same machine.
 */
export function acquire(
  serverId: string,
  create: () => RelayClient,
  key = "",
): RelayClient {
  const existing = entries.get(serverId);
  if (existing) {
    if (existing.key === key) {
      existing.refs += 1;
      return existing.client;
    }
    // Same machine, different route. Replace the client under the same id:
    // every call site reads through `get`/`getActive` on each use rather than
    // caching the object, so nobody is left holding the old one.
    existing.client.disconnect();
    existing.client = create();
    existing.key = key;
    existing.refs += 1;
    return existing.client;
  }

  const client = create();
  entries.set(serverId, { client, refs: 1, key });
  return client;
}

/**
 * Drop a reference. The last one out disconnects and forgets the client.
 *
 * Releasing something that was never acquired is a no-op rather than an error —
 * a cleanup running after a hot reload has no better option, and throwing there
 * would take the page down.
 */
export function release(serverId: string): void {
  const entry = entries.get(serverId);
  if (!entry) return;
  entry.refs -= 1;
  if (entry.refs > 0) return;
  entries.delete(serverId);
  entry.client.disconnect();
  if (active === serverId) active = null;
}

export function get(serverId: string): RelayClient | null {
  return entries.get(serverId)?.client ?? null;
}

/** Point `getActive()` at a machine. Pass null to mean "no terminal open". */
export function setActive(serverId: string | null): void {
  active = serverId;
}

export function getActive(): RelayClient | null {
  return active === null ? null : get(active);
}

/** The machine the terminal is currently driving, or null. */
export function getActiveServerId(): string | null {
  return active;
}

/**
 * Machines with a live client right now.
 *
 * The dashboard uses this to *avoid* probing: a server already on the other end
 * of an authenticated socket can be read from the store instead of dialled
 * again.
 */
export function heldServerIds(): string[] {
  return [...entries.keys()];
}

/** Test seam. Drops every client without disconnecting anything. */
export function resetRegistry(): void {
  entries.clear();
  active = null;
}
