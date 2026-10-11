import type { SealedDescriptor } from "@repo/protocol";
import type { SealedRecord, SessionKeys } from "@repo/crypto";
import { openJson, recordAad, sealJson } from "@repo/crypto";
import { cacheKeys, cachedKeys, isEnrolled, masterKey } from "./unlocked";

/**
 * Where a paired session lives in the browser.
 *
 * Key material goes in IndexedDB, never localStorage: an XSS can read
 * localStorage in one line, and today's 64-hex token sitting there is the
 * single worst part of the current design.
 *
 * ## Why the descriptor is in IndexedDB too
 *
 * It used to live only in sessionStorage, "so it dies with the tab" — which
 * sounded like a security property and was really just a bug. The keys survive
 * a reload in IndexedDB; the descriptor did not, so a refresh left the browser
 * holding a working key schedule with no idea where to use it and sent the user
 * back to re-pair. Nothing about candidate URLs and a tunnel id is more secret
 * than the keys that are the only way to use them.
 *
 * So the durable copy is in IndexedDB, keyed by the paired machine's device id,
 * and sessionStorage is kept as a synchronous mirror — `resolveRelayWsUrl` and
 * the `/file` URL builders are called during render and cannot await. Call
 * `hydrateDescriptor()` once on boot to refill the mirror from the durable
 * copy.
 *
 * ## What is deliberately not in the durable record
 *
 * `directToken`. Not because persisting it would be new exposure — it is
 * derived from the pairing keys and `saveSessionKeys` already writes it to
 * IndexedDB under the same device id — but because a second copy is a second
 * thing to get wrong, with nothing to gain. `hydrateDescriptor` reads it back
 * out of the keys record and puts it in the tab-scoped mirror, so its
 * synchronous availability stays exactly as wide as before and its persistent
 * footprint stays exactly one record.
 */

const DB_NAME = "tmuxde";
/**
 * v2 added the descriptor store; v3 added `lock` and `census`; v4 adds
 * `machines`.
 *
 * Every upgrade here is store creation only. **No version of this may move
 * data**: an upgrade that rewrites every record can half-fail — another tab
 * blocking the upgrade, a phone killed mid-transaction — and the half-written
 * state is a device that can no longer reach its own keys. The lock's sealed
 * records are therefore a structurally-discriminated union read at access
 * time, not a migration.
 */
const DB_VERSION = 4;
export const KEY_STORE = "session-keys";
/** Durable connection descriptors, keyed by device id. See the note above. */
export const DESCRIPTOR_STORE = "descriptors";
/** Wrapped master key and factor records for the device lock. See lock-store.ts. */
export const LOCK_STORE = "lock";
/** Cached per-server session lists for the dashboard. See session-census.ts. */
export const CENSUS_STORE = "census";
/** Device-local names and ordering for paired machines. See machine-directory.ts. */
export const MACHINE_STORE = "machines";
const DESCRIPTOR_KEY = "tmuxde:session-descriptor";

export type PairedSession = {
  descriptor: SealedDescriptor;
  /** Which candidate won the race last time, so we can try it first. */
  preferredCandidate?: string;
  /**
   * The derived relay token, carried alongside the descriptor in memory.
   *
   * `/file` requests are plain HTTP — an `<a download>` navigation cannot carry
   * an Authorization header, and `fetch` callers are synchronous — so the token
   * has to be readable without awaiting IndexedDB. It therefore lives in the
   * sessionStorage mirror, never in localStorage and never in the durable
   * record: the one persistent copy is the one `saveSessionKeys` already writes
   * to IndexedDB, and `hydrateDescriptor` reads it back from there. This is a
   * 24-hour scoped session token, the same class of credential as the
   * self-hosted path's `tmuxde-token`, not the machine's long-lived
   * AUTH_TOKEN — which never reaches the browser at all.
   */
  directToken?: string;
  pairedAt: number;
};

export type StoredKeys = {
  c2s: Uint8Array;
  s2c: Uint8Array;
  confirm: Uint8Array;
  directToken: string;
  /** Sessions the user asked to be re-prompted for. Only ever seen sealed. */
  sessionLocks?: Record<string, true>;
};

/**
 * What is actually in the `session-keys` store: a plaintext record, or a sealed
 * one once a device lock is enrolled.
 *
 * **Structurally discriminated, deliberately not migrated.** A version bump
 * that had to rewrite every record could half-fail — a second tab blocking the
 * upgrade, a phone killed mid-transaction — and a half-rewritten key store is a
 * device that can no longer reach its own keys. Reading the shape at access
 * time cannot half-fail. Existing plaintext records therefore read exactly as
 * they did before this feature existed.
 */
export type KeyRecord = StoredKeys | SealedRecord;

export function isSealed(record: unknown): record is SealedRecord {
  return (
    typeof record === "object" &&
    record !== null &&
    (record as { v?: unknown }).v === 1 &&
    "ct" in record
  );
}

export function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      for (const name of [
        KEY_STORE,
        DESCRIPTOR_STORE,
        LOCK_STORE,
        CENSUS_STORE,
        MACHINE_STORE,
      ]) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("indexedDB"));
  });
}

/**
 * One transaction spanning several stores, resolving when it *commits*.
 *
 * The single-store `tx` below resolves on the request, which is a different
 * moment — enrolling the lock has to seal every key record and write the lock
 * record atomically, and "the last put succeeded" is not the same promise as
 * "the transaction committed". IndexedDB transactions really are atomic, so
 * waiting for `oncomplete` is what makes a half-sealed, unopenable device
 * impossible rather than merely unlikely.
 */
export function txMulti(
  db: IDBDatabase,
  storeNames: string[],
  mode: IDBTransactionMode,
  run: (stores: Record<string, IDBObjectStore>) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeNames, mode);
    const stores: Record<string, IDBObjectStore> = {};
    for (const name of storeNames) stores[name] = transaction.objectStore(name);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new Error("indexedDB"));
    transaction.onabort = () =>
      reject(transaction.error ?? new Error("indexedDB: aborted"));
    try {
      run(stores);
    } catch (err) {
      transaction.abort();
      reject(err);
    }
  });
}

export function tx<T>(
  db: IDBDatabase,
  storeName: string,
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const request = run(db.transaction(storeName, mode).objectStore(storeName));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("indexedDB"));
  });
}

/** The AAD slot every session-keys record is sealed under. */
export function keysAad(serverId: string): string {
  return recordAad("session-keys", serverId);
}

/**
 * What actually goes inside a sealed record.
 *
 * Number arrays, not `Uint8Array`. `sealJson` goes through `JSON.stringify`,
 * and a typed array stringifies to `{"0":1,"1":2,…}` — an object with no
 * `length`, which `new Uint8Array(…)` silently turns into an empty array rather
 * than failing. That would seal the keys and hand back zeroes on the way out.
 * The plaintext (unsealed) shape keeps `Uint8Array`, because IndexedDB stores
 * typed arrays structurally and there is no JSON step to lose them.
 */
type SealedKeys = {
  c2s: number[];
  s2c: number[];
  confirm: number[];
  directToken: string;
  sessionLocks?: Record<string, true>;
};

export function toSealedKeys(keys: StoredKeys): SealedKeys {
  return {
    c2s: Array.from(keys.c2s),
    s2c: Array.from(keys.s2c),
    confirm: Array.from(keys.confirm),
    directToken: keys.directToken,
    ...(keys.sessionLocks ? { sessionLocks: keys.sessionLocks } : {}),
  };
}

export function fromSealedKeys(sealed: SealedKeys): StoredKeys {
  return {
    c2s: Uint8Array.from(sealed.c2s),
    s2c: Uint8Array.from(sealed.s2c),
    confirm: Uint8Array.from(sealed.confirm),
    directToken: sealed.directToken,
    ...(sealed.sessionLocks ? { sessionLocks: sealed.sessionLocks } : {}),
  };
}

/**
 * Seal a record if — and only if — this device is both enrolled and unlocked.
 *
 * ## The third case is reachable, and it throws
 *
 * This used to say the enrolled-but-locked case "cannot happen here: writing
 * keys means a pairing just completed, and pairing is only reachable from an
 * unlocked app." That was false. `/pair` and `/j` live in the `(auth)` group,
 * which is outside `LockGate` — deliberately, because they are how a locked
 * device would re-pair, and a lock screen in front of them would be a lockout.
 *
 * So the case not only can happen, it is exactly what happens when someone with
 * a locked device does the obvious thing and pairs again. And the old behaviour
 * was the worst available: return the record *unsealed*, writing this machine's
 * session keys to IndexedDB in the clear on a device whose entire point is that
 * they are not. One re-pair silently downgraded the lock to decorative.
 *
 * Throwing is right rather than merely safe. There is no correct record to
 * write: sealing needs a master key nobody has, and writing plaintext defeats
 * the feature. The caller surfaces it, and the fix the user needs — unlock
 * first, or erase and start over — is a thing they can actually do. The lock
 * screen's escape hatch exists for the second half of that sentence.
 */
function sealKeysIfUnlocked(serverId: string, plain: StoredKeys): KeyRecord {
  if (!isEnrolled()) return plain;
  const mk = masterKey();
  if (!mk) {
    throw new Error(
      "This device is locked. Unlock it before pairing, or erase it and start over.",
    );
  }
  return sealJson(mk, toSealedKeys(plain), keysAad(serverId));
}

export async function saveSessionKeys(
  serverId: string,
  keys: SessionKeys,
): Promise<void> {
  const db = await openDb();
  const plain: StoredKeys = {
    c2s: keys.c2s,
    s2c: keys.s2c,
    confirm: keys.confirm,
    directToken: keys.directToken,
  };
  // Written sealed when a lock is enrolled and open, so pairing a second
  // machine after enrolling does not quietly leave one record in the clear.
  const record = sealKeysIfUnlocked(serverId, plain);
  await tx(db, KEY_STORE, "readwrite", (store) => store.put(record, serverId));
  db.close();
  if (isSealed(record)) cacheKeys(serverId, plain);
}

/**
 * Read a paired machine's keys.
 *
 * Returns null when the record is sealed and the device is locked — which the
 * callers already handle, because it is indistinguishable from "this browser
 * has never paired with that machine". The lock screen is rendered by
 * `LockGate` on the enrolled-but-locked state, not by anything here.
 */
export async function loadSessionKeys(
  serverId: string,
): Promise<SessionKeys | null> {
  const cached = cachedKeys(serverId);
  if (cached) return cached;
  try {
    const db = await openDb();
    const stored = await tx<KeyRecord | undefined>(
      db,
      KEY_STORE,
      "readonly",
      (store) => store.get(serverId),
    );
    db.close();
    if (!stored) return null;

    if (isSealed(stored)) {
      const mk = masterKey();
      if (!mk) return null;
      const opened = fromSealedKeys(
        openJson<SealedKeys>(mk, stored, keysAad(serverId)),
      );
      cacheKeys(serverId, opened);
      return {
        c2s: opened.c2s,
        s2c: opened.s2c,
        confirm: opened.confirm,
        directToken: opened.directToken,
      };
    }

    return {
      c2s: new Uint8Array(stored.c2s),
      s2c: new Uint8Array(stored.s2c),
      confirm: new Uint8Array(stored.confirm),
      directToken: stored.directToken,
    };
  } catch {
    // A private-mode browser with IndexedDB blocked simply has no session; a
    // tag failure here means a tampered record, which is equally "no session".
    return null;
  }
}

export async function clearSessionKeys(serverId: string): Promise<void> {
  try {
    const db = await openDb();
    await tx(db, KEY_STORE, "readwrite", (store) => store.delete(serverId));
    db.close();
  } catch {
    // Nothing to clear.
  }
}

// ---------------------------------------------------------------------------
// The descriptor: durable in IndexedDB, mirrored in sessionStorage
// ---------------------------------------------------------------------------

/** What actually survives a reload — see the note at the top of this file. */
export type StoredDescriptor = Omit<PairedSession, "directToken">;

function writeMirror(session: PairedSession): void {
  if (typeof window === "undefined") return;
  sessionStorage.setItem(DESCRIPTOR_KEY, JSON.stringify(session));
}

/**
 * Persist a completed pairing.
 *
 * The mirror is written synchronously because the very next thing the caller
 * does is navigate to the terminal, where `resolveRelayWsUrl` reads it during
 * render. The durable copy follows on its own; a browser that blocks IndexedDB
 * still gets a working session for the life of the tab.
 */
export function saveDescriptor(session: PairedSession): void {
  writeMirror(session);
  void (async () => {
    try {
      const { directToken: _omitted, ...durable } = session;
      const db = await openDb();
      await tx(db, DESCRIPTOR_STORE, "readwrite", (store) =>
        store.put(
          durable satisfies StoredDescriptor,
          serverIdFor(session.descriptor),
        ),
      );
      db.close();
    } catch {
      // Private mode, or a blocked upgrade. The tab still works.
    }
  })();
}

/** Synchronous read of the tab's mirror. Never touches IndexedDB. */
export function loadDescriptor(): PairedSession | null {
  if (typeof window === "undefined") return null;
  const raw = sessionStorage.getItem(DESCRIPTOR_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as PairedSession;
  } catch {
    sessionStorage.removeItem(DESCRIPTOR_KEY);
    return null;
  }
}

/**
 * Refill the mirror from IndexedDB, so a reload does not force a re-pair.
 *
 * Call this once before anything reads `loadDescriptor()` in a fresh tab. It is
 * a no-op when the mirror is already populated *and still usable*, so calling it
 * on every route is cheap. The most recent pairing wins when a browser has
 * several paired machines: there is one active session at a time and it is the
 * one the user last chose.
 *
 * ## Why the mirror is checked rather than trusted
 *
 * This used to return the sessionStorage mirror on sight. The terminal's auth
 * guard requires the *keys*, not just the descriptor — so a mirror that
 * outlived its IndexedDB keys satisfied this function and failed the guard,
 * which bounced to an entry page, which called this function, which returned
 * the mirror, which… The address bar ping-ponged until the tab was killed.
 *
 * That is not hypothetical: Safari's ITP evicts IndexedDB after seven days
 * without a visit and leaves sessionStorage alone, which produces exactly this
 * pair of states. Validating here makes the two sides agree on one definition
 * of "usable"; `bounce-guard.ts` is the backstop for any future disagreement.
 */
export async function hydrateDescriptor(): Promise<PairedSession | null> {
  if (typeof window === "undefined") return null;
  const mirrored = loadDescriptor();
  if (mirrored) {
    const keys = await loadSessionKeys(serverIdFor(mirrored.descriptor));
    if (keys) return mirrored;
    // A stale mirror. Drop it, then fall through — another machine's durable
    // record may still be perfectly good, and re-pairing when one exists would
    // be a worse answer than looking.
    clearDescriptorMirror();
  }

  try {
    const db = await openDb();
    const stored = await tx<StoredDescriptor[]>(
      db,
      DESCRIPTOR_STORE,
      "readonly",
      (store) => store.getAll(),
    );
    db.close();

    const newest = stored
      .filter((s) => s?.descriptor)
      .sort((a, b) => b.pairedAt - a.pairedAt)[0];
    if (!newest) return null;

    // The token is not in the durable record on purpose; it comes back out of
    // the keys, which are the only thing that could use it anyway.
    const keys = await loadSessionKeys(serverIdFor(newest.descriptor));
    if (!keys) return null;

    const session: PairedSession = {
      ...newest,
      directToken: keys.directToken,
    };
    writeMirror(session);
    return session;
  } catch {
    return null;
  }
}

/**
 * Every machine this browser holds a usable pairing for.
 *
 * The dashboard lists servers from the account, which is a different question
 * from "can this browser open one" — the account knows the machine exists, but
 * only this device holds the keys. Intersecting the two is what lets the
 * dashboard show Connect on the servers it can actually reach and an honest
 * "pair this device first" on the rest.
 *
 * A descriptor with no surviving keys is not usable, so it is filtered out
 * rather than offered and then failing on click.
 */
export async function listPairedServerIds(): Promise<string[]> {
  if (typeof window === "undefined") return [];
  try {
    const db = await openDb();
    const stored = await tx<StoredDescriptor[]>(
      db,
      DESCRIPTOR_STORE,
      "readonly",
      (store) => store.getAll(),
    );
    db.close();

    const ids = stored
      .filter((s) => s?.descriptor)
      .map((s) => serverIdFor(s.descriptor));
    const usable = await Promise.all(
      ids.map(async (id) => ((await loadSessionKeys(id)) ? id : null)),
    );
    return usable.filter((id): id is string => id !== null);
  } catch {
    return [];
  }
}

/**
 * Make a previously paired machine the active session.
 *
 * This is the whole of "connect from the dashboard": the keys and the
 * descriptor are already on this device from the first pairing, so switching
 * machines is a local lookup and a mirror write, with nothing asked of the
 * broker and no new code to type. Returns null when this browser has never
 * paired with that machine, which the caller renders as an invitation to pair.
 */
export async function activateDescriptor(
  serverId: string,
): Promise<PairedSession | null> {
  if (typeof window === "undefined") return null;
  try {
    const db = await openDb();
    const stored = await tx<StoredDescriptor | undefined>(
      db,
      DESCRIPTOR_STORE,
      "readonly",
      (store) => store.get(serverId),
    );
    db.close();
    if (!stored?.descriptor) return null;

    const keys = await loadSessionKeys(serverId);
    if (!keys) return null;

    const session: PairedSession = { ...stored, directToken: keys.directToken };
    writeMirror(session);
    return session;
  } catch {
    return null;
  }
}

/**
 * Drop the tab's mirror without touching the durable record.
 *
 * What locking does: the descriptor stays on disk so the dashboard can still
 * render "Locked — unlock to connect" rather than an empty list, but nothing in
 * this tab can resolve a relay URL until the mirror is refilled.
 * `resolveRelayWsUrl()` already falls through to `""` and `useWebSocket`
 * early-returns on that, so no new code is needed downstream.
 */
export function clearDescriptorMirror(): void {
  if (typeof window === "undefined") return;
  sessionStorage.removeItem(DESCRIPTOR_KEY);
}

/**
 * Read one machine's stored route without making it the active session.
 *
 * `activateDescriptor` writes the sessionStorage mirror, so using it merely to
 * *look up* a machine's candidate URLs would silently repoint the terminal at
 * whichever machine the dashboard happened to probe last. The census needs the
 * read and not the switch, so it gets its own function.
 */
export async function loadDescriptorFor(
  serverId: string,
): Promise<StoredDescriptor | null> {
  if (typeof indexedDB === "undefined") return null;
  try {
    const db = await openDb();
    const stored = await tx<StoredDescriptor | undefined>(
      db,
      DESCRIPTOR_STORE,
      "readonly",
      (store) => store.get(serverId),
    );
    db.close();
    return stored?.descriptor ? stored : null;
  } catch {
    return null;
  }
}

export function clearDescriptor(): void {
  if (typeof window === "undefined") return;
  const session = loadDescriptor();
  sessionStorage.removeItem(DESCRIPTOR_KEY);
  if (!session) return;
  void (async () => {
    try {
      const db = await openDb();
      await tx(db, DESCRIPTOR_STORE, "readwrite", (store) =>
        store.delete(serverIdFor(session.descriptor)),
      );
      db.close();
    } catch {
      // Nothing to clear.
    }
  })();
}

/**
 * Drop one machine's durable descriptor, whether or not it is the active one.
 *
 * `clearDescriptor` above can only forget whatever this tab is currently
 * pointed at, which is the wrong shape for a list: forgetting the third machine
 * in a dashboard would have meant activating it first — repointing the terminal
 * at a machine on the way to deleting it.
 *
 * The mirror is cleared too, but only when it names this machine. Dropping it
 * unconditionally would sign the tab out of a machine the user did not touch.
 */
export async function clearDescriptorFor(serverId: string): Promise<void> {
  if (typeof window === "undefined") return;
  const active = loadDescriptor();
  if (active && serverIdFor(active.descriptor) === serverId) {
    sessionStorage.removeItem(DESCRIPTOR_KEY);
  }
  try {
    const db = await openDb();
    await tx(db, DESCRIPTOR_STORE, "readwrite", (store) =>
      store.delete(serverId),
    );
    db.close();
  } catch {
    // Nothing to clear.
  }
}

/** Stable id for a paired machine — its device fingerprint. */
export function serverIdFor(descriptor: SealedDescriptor): string {
  return descriptor.deviceId;
}
