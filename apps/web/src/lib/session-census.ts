/**
 * Every tmux session on every machine this browser can reach, gathered here.
 *
 * ## Why there is no `GET /v1/servers/:id/sessions`
 *
 * Because that endpoint would be a breach of invariant #2, and it is the
 * shortcut this feature invites. The broker is blind by construction: it routes
 * on a slot id and forwards sealed frames it cannot open, and it logs counts and
 * outcomes only. A dashboard endpoint returning session names would hand it —
 * and anyone with a subpoena, a backup, or a stray access log — the exact
 * mapping the design exists to deny: *this account, on this machine, is running
 * `deploy-prod` and `client-acme`.*
 *
 * The names would arrive at the broker in plaintext, because only the browser
 * and the CLI hold the pairing keys. There is no way to add such a route and
 * keep the central claim true. So the fan-out is done here, from the device that
 * already holds the keys, one short-lived authenticated connection per machine.
 * It is more code and it is slower. That is the price of the claim.
 *
 * For the same reason the cache below lives in IndexedDB rather than
 * localStorage. Session names are precisely the kind of thing that house rule
 * exists for: an XSS reads localStorage in one line.
 *
 * ## Shape
 *
 * `runCensus` is pure orchestration — a bounded pool, a cache, a timeout and a
 * progress callback — with the per-server probe and the clock injected. That is
 * what makes it testable in the existing node-only vitest project without
 * reaching for jsdom or a fake DOM. The browser probe (`browserProbe`) is the
 * only part that touches IndexedDB and sockets, and it is assembled from pieces
 * that already exist: `raceCandidates` for the direct path and the transports
 * from `transport.ts` for the sealed tunnel.
 */

import type { SessionInfo } from "@repo/protocol";
import { tryDeserializeServerMessage } from "@repo/protocol";
import type { SealedDescriptor } from "@repo/protocol";
import type { Capabilities } from "@/stores/connection-store";
import { probeUrlFor, raceCandidates } from "./candidate-race";
import {
  CENSUS_STORE,
  listPairedServerIds,
  loadDescriptorFor,
  loadSessionKeys,
  openDb,
  tx,
} from "./session-store";
import {
  directTransport,
  sealedTransport,
  type TransportFactory,
} from "./transport";

/**
 * Four at a time. Enough that eight machines finish in two rounds, few enough
 * that a phone on a flaky network is not opening eight sockets at once.
 */
export const CENSUS_CONCURRENCY = 4;

/** Per-server budget. One dead machine must never hold up the list. */
export const CENSUS_TIMEOUT_MS = 3_000;

/**
 * How long a cached answer is worth showing without re-checking over the
 * tunnel. Direct probes are free (they are on your own network); a tunnel probe
 * spends metered relay bytes, so it waits for a stale cache or an explicit ask.
 */
export const CENSUS_STALE_MS = 5 * 60_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CensusTarget = {
  /** The paired machine's device id — the key everything else is filed under. */
  serverId: string;
  /** Human name: the account's label when signed in, else the pairing's. */
  name: string;
  /** The broker's hint, when signed in. Advisory; the probe is the truth. */
  online?: boolean;
  /**
   * Whether this browser holds keys for the machine.
   *
   * False means it is on the account but not on this device, so it is listed
   * as something to pair with and **never probed** — there is no key to
   * authenticate with and nothing a socket could ask. Absent is treated as
   * true, so a caller constructing targets by hand keeps the old behaviour.
   */
  paired?: boolean;
};

export type CensusSnapshot = {
  sessions: SessionInfo[];
  /** From `auth:success`, so the row can show read-only / files-off chips. */
  capabilities: Capabilities | null;
  observedAt: number;
};

export type CensusRow = CensusTarget & {
  sessions: SessionInfo[];
  capabilities: Capabilities | null;
  /** When these sessions were seen, or null when they never have been. */
  observedAt: number | null;
  /**
   * `live` — just fetched. `cache` — last known, shown greyed with its age.
   * `active` — read from the open connection rather than probed at all.
   */
  source: "live" | "cache" | "active";
  /** True while a probe for this row is still outstanding. */
  pending: boolean;
  /** Set when the probe failed. The row still renders, greyed, with a Retry. */
  error: string | null;
};

export type ProbeOptions = {
  /**
   * False means "do not spend metered bytes on this one" — the cache is fresh
   * and the user did not ask. The probe may still try direct candidates, which
   * cost nothing, and returns null if none of them answer.
   */
  allowTunnel: boolean;
  timeoutMs: number;
};

/**
 * Ask one machine what it is running.
 *
 * Returning `null` means "declined to look" — not an error, not offline. The
 * caller keeps whatever it had cached and says nothing alarming.
 */
export type CensusProbe = (
  target: CensusTarget,
  options: ProbeOptions,
) => Promise<CensusSnapshot | null>;

export type CensusCache = {
  read(serverId: string): Promise<CensusSnapshot | null>;
  write(serverId: string, snapshot: CensusSnapshot): Promise<void>;
};

export type RunCensusOptions = {
  targets: readonly CensusTarget[];
  probe: CensusProbe;
  /** Omit or pass null to run without one — the tests do. */
  cache?: CensusCache | null;
  /**
   * Servers already on the end of an authenticated socket. These are never
   * probed: the live connection is more current than anything a second one
   * could tell us, and dialling a machine we are already talking to is waste.
   */
  live?: ReadonlyMap<string, CensusSnapshot>;
  /** Called for every row transition, so the list paints as answers land. */
  onUpdate?: (row: CensusRow) => void;
  concurrency?: number;
  timeoutMs?: number;
  staleMs?: number;
  /** The user pressed Refresh, so the tunnel is fair game even when fresh. */
  force?: boolean;
  now?: () => number;
};

// ---------------------------------------------------------------------------
// The fan-out
// ---------------------------------------------------------------------------

/**
 * Probe every machine, bounded and progressively.
 *
 * The ordering is the point: cached rows are emitted before a single socket is
 * opened, so a returning visitor sees their sessions immediately and watches
 * them refresh, rather than watching a spinner. `Promise.allSettled` over a
 * fixed-size pool means one machine that is off, asleep or behind a captive
 * portal costs its own timeout and nothing else's.
 */
export async function runCensus(
  options: RunCensusOptions,
): Promise<CensusRow[]> {
  const {
    targets,
    probe,
    cache = null,
    live,
    onUpdate,
    concurrency = CENSUS_CONCURRENCY,
    timeoutMs = CENSUS_TIMEOUT_MS,
    staleMs = CENSUS_STALE_MS,
    force = false,
    now = Date.now,
  } = options;

  const rows = new Map<string, CensusRow>();
  const emit = (row: CensusRow) => {
    rows.set(row.serverId, row);
    onUpdate?.(row);
  };

  // Anything with a live connection is already answered. Emit it and take it
  // out of the queue before we spend anything.
  const queue: CensusTarget[] = [];
  for (const target of targets) {
    // An unpaired machine is listed so the user can act on it, and never
    // probed: this browser holds no key for it, so there is no socket to open
    // and nothing a probe could ask. It skips the cache read too — there can be
    // no cached sessions for a machine that has never been talked to.
    if (target.paired === false) {
      emit({
        ...target,
        sessions: [],
        capabilities: null,
        observedAt: null,
        source: "cache",
        pending: false,
        error: null,
      });
      continue;
    }

    const open = live?.get(target.serverId);
    if (open) {
      emit({
        ...target,
        sessions: open.sessions,
        capabilities: open.capabilities,
        observedAt: open.observedAt,
        source: "active",
        pending: false,
        error: null,
      });
    } else {
      queue.push(target);
    }
  }

  // One cache round trip for the whole list, then every cached row is on screen
  // before the first socket opens.
  const cached = new Map<string, CensusSnapshot | null>();
  await Promise.all(
    queue.map(async (target) => {
      const snapshot = cache ? await safeRead(cache, target.serverId) : null;
      cached.set(target.serverId, snapshot);
    }),
  );

  for (const target of queue) {
    const snapshot = cached.get(target.serverId) ?? null;
    emit({
      ...target,
      sessions: snapshot?.sessions ?? [],
      capabilities: snapshot?.capabilities ?? null,
      observedAt: snapshot?.observedAt ?? null,
      source: "cache",
      pending: true,
      error: null,
    });
  }

  let next = 0;
  const workers = Array.from(
    { length: Math.max(1, Math.min(concurrency, queue.length)) },
    async () => {
      for (;;) {
        const target = queue[next++];
        if (!target) return;
        await probeOne(target);
      }
    },
  );

  async function probeOne(target: CensusTarget): Promise<void> {
    const snapshot = cached.get(target.serverId) ?? null;
    const stale = !snapshot || now() - snapshot.observedAt > staleMs;
    try {
      const result = await withTimeout(
        probe(target, { allowTunnel: force || stale, timeoutMs }),
        timeoutMs,
      );
      if (result === null) {
        // Declined, not failed. Keep what we had and say nothing.
        emit({
          ...target,
          sessions: snapshot?.sessions ?? [],
          capabilities: snapshot?.capabilities ?? null,
          observedAt: snapshot?.observedAt ?? null,
          source: "cache",
          pending: false,
          error: null,
        });
        return;
      }
      if (cache) await safeWrite(cache, target.serverId, result);
      emit({
        ...target,
        sessions: result.sessions,
        capabilities: result.capabilities,
        observedAt: result.observedAt,
        source: "live",
        pending: false,
        error: null,
      });
    } catch (error) {
      // Offline is a state, not a failure to hide. The row keeps its last known
      // sessions, greyed and dated, so there is something to act on and never
      // an endless spinner.
      emit({
        ...target,
        sessions: snapshot?.sessions ?? [],
        capabilities: snapshot?.capabilities ?? null,
        observedAt: snapshot?.observedAt ?? null,
        source: "cache",
        pending: false,
        error: messageFor(error),
      });
    }
  }

  await Promise.allSettled(workers);

  return targets
    .map((target) => rows.get(target.serverId))
    .filter((row): row is CensusRow => row !== undefined);
}

function messageFor(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "Could not reach that machine.";
}

async function safeRead(
  cache: CensusCache,
  serverId: string,
): Promise<CensusSnapshot | null> {
  try {
    return await cache.read(serverId);
  } catch {
    return null;
  }
}

async function safeWrite(
  cache: CensusCache,
  serverId: string,
  snapshot: CensusSnapshot,
): Promise<void> {
  try {
    await cache.write(serverId, snapshot);
  } catch {
    // A private-mode browser simply has no cache. Not worth a toast.
  }
}

/**
 * Bound a promise, and make sure the loser cannot bring the process down.
 *
 * The swallowed rejection matters: once the timeout wins, the original promise
 * is unobserved, and an unhandled rejection from a socket that fails a moment
 * later is a crash in Node and a console error in the browser.
 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("Timed out")), ms);
  });
  promise.catch(() => {});
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// ---------------------------------------------------------------------------
// Who to ask
// ---------------------------------------------------------------------------

export type BrokerServer = {
  serverId: string;
  name: string;
  online: boolean;
};

/**
 * Every machine worth *listing*, paired ones first.
 *
 * The list starts from IndexedDB — the machines this browser holds keys for —
 * and the account is an enrichment on top, supplying a human name and an online
 * hint. That ordering is invariant #5 in one function: signed out, the account
 * half is simply absent and the dashboard still works.
 *
 * ## Unpaired machines are listed, and never probed
 *
 * This used to return `[]` the moment `paired` was empty, and to drop account
 * machines this browser had no keys for. The reasoning was that they have no
 * sessions to show — which is true, and was the wrong conclusion. It meant a
 * user with ten registered machines and a fresh phone opened the dashboard to
 * an empty list, with nothing on screen to act on and no hint that their
 * machines existed at all. The most common state for a new device rendered as
 * "you have nothing".
 *
 * So they are included with `paired: false`, and `runCensus` skips them
 * entirely: no socket, no cache read, no timeout budget spent. A row for one is
 * an invitation to pair, not a session list — the honest thing to show, rather
 * than nothing.
 *
 * The self-hosted path is unchanged by construction: `fetchServers` is only
 * passed on a hosted build (see `all-sessions.tsx`), so without it this returns
 * exactly the paired set it always did.
 */
export async function collectTargets(options?: {
  listPaired?: () => Promise<string[]>;
  /** Returns null when signed out, or when the broker cannot be reached. */
  fetchServers?: () => Promise<BrokerServer[] | null>;
  readLabel?: (serverId: string) => Promise<string | null>;
}): Promise<CensusTarget[]> {
  const listPaired = options?.listPaired ?? listPairedServerIds;
  const readLabel = options?.readLabel ?? readPairedLabel;

  const paired = await listPaired();

  let account: BrokerServer[] | null = null;
  if (options?.fetchServers) {
    try {
      account = await options.fetchServers();
    } catch {
      // Signed out, offline, or a self-hosted build with no broker at all.
      account = null;
    }
  }
  const byId = new Map((account ?? []).map((s) => [s.serverId, s]));
  const pairedSet = new Set(paired);

  const pairedTargets = await Promise.all(
    paired.map(async (serverId) => {
      const known = byId.get(serverId);
      const label = known?.name ?? (await readLabel(serverId));
      return {
        serverId,
        name: label || "Unnamed machine",
        online: known?.online,
        paired: true,
      } satisfies CensusTarget;
    }),
  );

  // Paired first: they are the ones with something to say, and a list that
  // opens with rows you cannot use is a worse list.
  const unpaired = (account ?? [])
    .filter((s) => !pairedSet.has(s.serverId))
    .map(
      (s) =>
        ({
          serverId: s.serverId,
          name: s.name || "Unnamed machine",
          online: s.online,
          paired: false,
        }) satisfies CensusTarget,
    );

  return [...pairedTargets, ...unpaired];
}

// ---------------------------------------------------------------------------
// The probe
// ---------------------------------------------------------------------------

/** What a probe needs from a socket. Deliberately the `Transport` surface. */
export type CensusHandlers = {
  onOpen: () => void;
  onMessage: (text: string) => void;
  onClose: () => void;
};

export type CensusLink = { send(text: string): void; close(): void };

export type CensusConnector = (handlers: CensusHandlers) => CensusLink;

/**
 * One connection's worth of conversation: authenticate, ask, hang up.
 *
 * Nothing is attached and no PTY is spawned, so this is the cheapest question
 * you can ask a relay. The socket is closed on every exit path — a probe that
 * leaked a connection per machine per refresh would be worse than no dashboard.
 */
export function askSessions(
  connect: CensusConnector,
  token: string,
  timeoutMs: number = CENSUS_TIMEOUT_MS,
): Promise<CensusSnapshot> {
  return new Promise<CensusSnapshot>((resolve, reject) => {
    let settled = false;
    let link: CensusLink | null = null;
    let capabilities: Capabilities | null = null;

    const timer = setTimeout(() => finish(new Error("Timed out")), timeoutMs);

    function finish(error: Error | null, snapshot?: CensusSnapshot) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        link?.close();
      } catch {
        // Already closing.
      }
      if (error) reject(error);
      else resolve(snapshot!);
    }

    try {
      link = connect({
        onOpen: () => link?.send(JSON.stringify({ type: "auth", token })),
        onMessage: (text) => {
          const parsed = tryDeserializeServerMessage(text);
          if (!parsed.ok) return;
          const msg = parsed.message;
          if (msg.type === "auth:success") {
            capabilities = msg.capabilities ?? null;
            link?.send(JSON.stringify({ type: "session:list" }));
            return;
          }
          if (msg.type === "auth:failure") {
            // The census probes machines the browser already has tokens for,
            // so "unapproved" here means the owner has not answered yet — a
            // live machine, not a dead pairing. Saying so keeps the card from
            // reading like the credential has expired.
            finish(
              new Error(
                msg.code === "unapproved"
                  ? "Waiting to be approved on that machine."
                  : msg.reason || "That machine refused this device.",
              ),
            );
            return;
          }
          if (msg.type === "session:list") {
            finish(null, {
              sessions: msg.sessions,
              capabilities,
              observedAt: Date.now(),
            });
          }
        },
        onClose: () => finish(new Error("That machine closed the connection.")),
      });
    } catch {
      finish(new Error("Could not open a connection."));
    }
  });
}

/** Adapt a `Transport` — direct or sealed — to the probe's seam. */
export function transportConnector(factory: TransportFactory): CensusConnector {
  return (handlers) => {
    const transport = factory();
    transport.connect(handlers);
    return {
      send: (text) => transport.send(text),
      close: () => transport.close(),
    };
  };
}

/**
 * The real probe: direct candidates first, the sealed tunnel only if asked.
 *
 * `raceCandidates` already caps the direct attempt at 800 ms and proves the far
 * end really is the paired machine by completing its auth handshake, so a
 * winner here is safe to reuse for the real question. When nothing wins we are
 * off the machine's network, and the only route left is the broker's tunnel —
 * which costs metered relay bytes, hence `allowTunnel`.
 */
export function browserProbe(options?: {
  /** Broker origin. Null in a self-hosted build; then there is no tunnel. */
  apiBase?: string | null;
}): CensusProbe {
  const apiBase = options?.apiBase ?? null;

  return async (target, { allowTunnel, timeoutMs }) => {
    const keys = await loadSessionKeys(target.serverId);
    if (!keys) {
      throw new Error("This browser no longer holds keys for that machine.");
    }

    const record = await readPairedRecord(target.serverId);
    if (!record) throw new Error("This browser has no route to that machine.");

    const candidates = orderCandidates(
      record.descriptor,
      record.preferredCandidate,
    );
    const race = await raceCandidates(candidates, keys.directToken);
    if (race.winner) {
      return askSessions(
        transportConnector(directTransport(probeUrlFor(race.winner))),
        keys.directToken,
        timeoutMs,
      );
    }

    if (!allowTunnel) return null;
    if (!apiBase) throw new Error("Not reachable from this network.");

    const url = `${apiBase.replace(/^http/, "ws")}/v1/tunnel/${record.descriptor.tunnelId}`;
    return askSessions(
      transportConnector(sealedTransport({ url, keys })),
      keys.directToken,
      timeoutMs,
    );
  };
}

/** Last winner first — it is the one most likely to answer again. */
export function orderCandidates(
  descriptor: SealedDescriptor,
  preferred?: string,
): string[] {
  const rest = descriptor.candidates.filter((c) => c !== preferred);
  return preferred ? [preferred, ...rest] : rest;
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

/**
 * The read that must not switch the active machine.
 *
 * `session-store` exposes `loadDescriptorFor` for exactly this: reaching for
 * `activateDescriptor` instead would be a bug, because it writes the
 * sessionStorage mirror — so merely *reading* a machine's route would silently
 * repoint the terminal at whichever machine the census probed last.
 */
const readPairedRecord = loadDescriptorFor;

async function readPairedLabel(serverId: string): Promise<string | null> {
  const record = await readPairedRecord(serverId);
  return record?.descriptor.label ?? null;
}

/**
 * Last known sessions, in IndexedDB.
 *
 * Never localStorage. A cache of "what is running on every machine you own" is
 * the single most descriptive thing this browser stores, and the rule about
 * key material exists for exactly this class of data.
 */
export const indexedDbCache: CensusCache = {
  async read(serverId) {
    if (typeof indexedDB === "undefined") return null;
    try {
      const db = await openDb();
      const stored = await tx<CensusSnapshot | undefined>(
        db,
        CENSUS_STORE,
        "readonly",
        (store) => store.get(serverId),
      );
      db.close();
      if (!stored || !Array.isArray(stored.sessions)) return null;
      return {
        sessions: stored.sessions,
        capabilities: stored.capabilities ?? null,
        observedAt: stored.observedAt ?? 0,
      };
    } catch {
      return null;
    }
  },

  async write(serverId, snapshot) {
    if (typeof indexedDB === "undefined") return;
    try {
      const db = await openDb();
      await tx(db, CENSUS_STORE, "readwrite", (store) =>
        store.put(snapshot, serverId),
      );
      db.close();
    } catch {
      // Private mode. The list still works, it just does not survive a reload.
    }
  },
};

/**
 * Forget every cached session list.
 *
 * Belongs on any path that says the words "erase this device", and on lock —
 * an overlay in front of a list of your session names is not a lock.
 */
export async function clearCensusCache(): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  try {
    const db = await openDb();
    await tx(db, CENSUS_STORE, "readwrite", (store) => store.clear());
    db.close();
  } catch {
    // Nothing to clear.
  }
}
