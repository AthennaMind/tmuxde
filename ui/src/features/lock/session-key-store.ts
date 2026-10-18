import type { SealedRecord } from "./lock-envelope";
import { openJson, recordAad, sealJson } from "./lock-envelope";
import { cacheKeys, cachedKeys, isEnrolled, masterKey } from "./unlocked";

/**
 * The browser's IndexedDB database and the session key records in it.
 *
 * Upstream stored paired machines here: session keys per machine and a
 * connection descriptor. Token login never writes either. The key records
 * stay because the device lock seals and opens whatever is in them, and
 * because an older browser may still hold some. The other stores are still
 * created, so the database version never has to move data, and erasing the
 * device clears them.
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
/** Connection descriptors of paired machines. Upstream only, never written. */
export const DESCRIPTOR_STORE = "descriptors";
/** Wrapped master key and factor records for the device lock. See lock-store.ts. */
export const LOCK_STORE = "lock";
/** Cached session lists of paired machines. Upstream only, never written. */
export const CENSUS_STORE = "census";
/** Local names of paired machines. Upstream only, never written. */
export const MACHINE_STORE = "machines";

/** Keys of one paired machine, as upstream pairing derived them. */
export type SessionKeys = {
  c2s: Uint8Array;
  s2c: Uint8Array;
  confirm: Uint8Array;
  directToken: string;
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
      for (const name of [KEY_STORE, DESCRIPTOR_STORE, LOCK_STORE, CENSUS_STORE, MACHINE_STORE]) {
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
    transaction.onerror = () => reject(transaction.error ?? new Error("indexedDB"));
    transaction.onabort = () => reject(transaction.error ?? new Error("indexedDB: aborted"));
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
 * Seal a record only if this device is both enrolled and unlocked.
 *
 * ## The third case is reachable, and it throws
 *
 * A device can be enrolled and locked here. The sign-in route lives in the
 * entry layout, which is outside `LockGate` on purpose. A lock screen in front
 * of sign-in would be a lockout.
 *
 * Returning the record unsealed in that case would write this machine's
 * session keys to IndexedDB in the clear, on a device whose entire point is
 * that they are not. One more sign-in would make the lock decorative.
 *
 * Throwing is right rather than merely safe. There is no correct record to
 * write. Sealing needs a master key nobody has, and writing plaintext defeats
 * the feature. The caller surfaces it. The user can unlock first, or erase and
 * start over. The lock screen's escape hatch exists for the second option.
 */
function sealKeysIfUnlocked(serverId: string, plain: StoredKeys): KeyRecord {
  if (!isEnrolled()) return plain;
  const mk = masterKey();
  if (!mk) {
    throw new Error("This device is locked. Unlock it before pairing, or erase it and start over.");
  }
  return sealJson(mk, toSealedKeys(plain), keysAad(serverId));
}

export async function saveSessionKeys(serverId: string, keys: SessionKeys): Promise<void> {
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
export async function loadSessionKeys(serverId: string): Promise<SessionKeys | null> {
  const cached = cachedKeys(serverId);
  if (cached) return cached;
  try {
    const db = await openDb();
    const stored = await tx<KeyRecord | undefined>(db, KEY_STORE, "readonly", (store) =>
      store.get(serverId),
    );
    db.close();
    if (!stored) return null;

    if (isSealed(stored)) {
      const mk = masterKey();
      if (!mk) return null;
      const opened = fromSealedKeys(openJson<SealedKeys>(mk, stored, keysAad(serverId)));
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
