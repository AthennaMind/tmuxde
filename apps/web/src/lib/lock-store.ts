import type { FactorRecord, SealedRecord } from "@repo/crypto";
import {
  derivePinKey,
  generateMasterKey,
  openJson,
  pbkdf2Iterations,
  recordAad,
  sealJson,
  unwrapMasterKey,
  wipe,
  wrapMasterKey,
} from "@repo/crypto";
import { TOKEN_KEY, clearStored, readStored } from "./storage-keys";
import {
  CENSUS_STORE,
  DESCRIPTOR_STORE,
  KEY_STORE,
  LOCK_STORE,
  fromSealedKeys,
  isSealed,
  keysAad,
  openDb,
  toSealedKeys,
  tx,
  txMulti,
  type KeyRecord,
  type StoredKeys,
} from "./session-store";
import {
  cacheKeys,
  cachedKeys,
  forget,
  isEnrolled,
  masterKey,
  setEnrolled,
  setLocalToken,
  setMasterKey,
} from "./unlocked";

/**
 * The device lock, as encryption at rest.
 *
 * A lock that is only a UI overlay is worthless: the keys sit in IndexedDB and
 * one line in devtools reads them. So enrolling seals every key record under a
 * master key that exists only in memory, and locking is dropping that key.
 *
 * ## What this does and does not protect against
 *
 * It protects against **a person holding your unlocked phone for the next few
 * minutes** — the realistic threat, which it handles well.
 *
 * It does **not** protect against someone who copies your IndexedDB and takes
 * it home. A 6-digit PIN behind PBKDF2-600k is roughly 16,000 guesses/s on one
 * consumer GPU, which exhausts the space in about a minute offline. That number
 * belongs in the UI, not just in this comment. Only the passkey factor, whose
 * PRF secret has 256 bits of entropy and never leaves the authenticator, defends
 * against the copy-it-and-leave attack.
 *
 * ## Why the throttle lives in the record
 *
 * In memory it would reset on reload, which is one keystroke away. And it is
 * incremented **before** the verification attempt, so killing the tab
 * mid-verify does not dodge the counter.
 */

const LOCK_KEY = "device";

/**
 * Where the self-hosted `tmuxde-token` goes once a lock exists.
 *
 * On that path the token in `localStorage` is a *working credential* — one line
 * in a devtools console, readable by any script on the origin, and it survives
 * a lock that encrypts everything else. Enrolling moves it here and deletes the
 * plaintext; unlocking puts it back in memory, where `getFileDownloadUrl()` can
 * still read it synchronously.
 *
 * A device with no lock keeps `localStorage` exactly as before. The self-hosted
 * path must not require anything, least of all a PIN.
 */
const LOCAL_TOKEN_KEY = "local-token";
const LOCAL_TOKEN_AAD_ID = "self-hosted";

/** Attempts before the delay starts. Three honest fat-finger tries. */
const FREE_ATTEMPTS = 3;
const MAX_LOCKOUT_MS = 15 * 60_000;
const WIPE_THRESHOLD = 10;

export type LockRecord = {
  v: 1;
  factors: FactorRecord[];
  /** Persisted so a reload cannot reset the throttle. */
  failedAttempts: number;
  /** Epoch ms until which verification is refused outright. */
  lockedUntil: number | null;
  /**
   * Erase every key after ten wrong PINs.
   *
   * **Default off.** A toddler mashing the pad is more likely than the threat
   * it stops, and it is defeated anyway by the same copy-the-database-first
   * attack that beats the PIN. It ships as a switch for people who want it.
   */
  wipeAfter10: boolean;
  /** Digits chosen at enrollment, so the pad draws the right number of dots. */
  pinLength: number;
  /** Minutes of inactivity before an automatic lock. */
  idleMinutes: number;
  /**
   * Lock when the tab goes to the background.
   *
   * **Default off on mobile.** iOS fires `visibilitychange` for the app
   * switcher, the share sheet, *and the Face ID prompt itself* — locking on
   * every one of those makes the app unusable, which is why this needs a grace
   * period and hard suppression during a WebAuthn ceremony to be worth having.
   */
  lockOnBackground: boolean;
  enrolledAt: number;
};

export type UnlockOutcome =
  | { ok: true }
  | { ok: false; reason: "wrong"; attemptsLeft: number | null }
  | { ok: false; reason: "throttled"; until: number }
  | { ok: false; reason: "wiped" }
  | { ok: false; reason: "no-lock" };

function defaults(): Omit<LockRecord, "factors" | "enrolledAt"> {
  return {
    v: 1,
    failedAttempts: 0,
    lockedUntil: null,
    wipeAfter10: false,
    pinLength: 6,
    idleMinutes: 15,
    lockOnBackground: false,
  };
}

export async function readLockRecord(): Promise<LockRecord | null> {
  // Guarded on `indexedDB`, not `window`: this has to answer in any context
  // that has a database, and guarding on `window` silently returned null under
  // the node test environment — which made the throttle look like it worked
  // while writing nothing at all.
  if (typeof indexedDB === "undefined") return null;
  try {
    const db = await openDb();
    const record = await tx<LockRecord | undefined>(
      db,
      LOCK_STORE,
      "readonly",
      (store) => store.get(LOCK_KEY),
    );
    db.close();
    return record ?? null;
  } catch {
    return null;
  }
}

async function writeLockRecord(record: LockRecord): Promise<void> {
  const db = await openDb();
  await tx(db, LOCK_STORE, "readwrite", (store) => store.put(record, LOCK_KEY));
  db.close();
}

/**
 * Tell the app whether a lock exists, once, at boot.
 *
 * Cheap and safe to call on every route — it only reads one record, and the
 * answer it caches in `unlocked.ts` is what `LockGate` renders from.
 */
export async function hydrateLockState(): Promise<boolean> {
  const record = await readLockRecord();
  const enrolled = (record?.factors.length ?? 0) > 0;
  setEnrolled(enrolled);
  return enrolled;
}

/**
 * Turn a PIN into a factor and seal every key record under a new master key.
 *
 * **One multi-store transaction.** IndexedDB transactions are genuinely
 * atomic, so either every record is sealed and the lock record exists, or
 * neither happened. Doing it in two steps would leave a window in which the
 * keys are sealed and the factor that unwraps them is not yet written — a
 * device bricked by a badly timed reload. `txMulti` resolves on `oncomplete`,
 * not on the last request, because those are different moments.
 */
export async function enrollPin(
  pin: string,
  options: { label?: string } = {},
): Promise<void> {
  if (await isEnrolledOnDisk()) {
    throw new Error("This device already has a lock.");
  }

  const mk = generateMasterKey();
  const iterations = pbkdf2Iterations();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const id = factorId();
  const factorKey = await derivePinKey(pin, salt, iterations);
  const wrapped = await wrapMasterKey(factorKey, mk, "pin", id);
  wipe(factorKey);

  const factor: FactorRecord = {
    v: 1,
    kind: "pin",
    id,
    salt,
    iterations,
    wrapped,
    createdAt: Date.now(),
    ...(options.label ? { label: options.label } : {}),
  };

  const record: LockRecord = {
    ...defaults(),
    pinLength: pin.length,
    factors: [factor],
    enrolledAt: Date.now(),
  };

  const db = await openDb();
  try {
    // Read every existing key record first, outside the write transaction, so
    // the transaction itself does nothing that can await and auto-close.
    const existing = await readAllKeyRecords(db);
    const sealedNow: [string, SealedRecord, StoredKeys][] = [];
    for (const [serverId, value] of existing) {
      if (isSealed(value)) continue;
      sealedNow.push([
        serverId,
        sealJson(mk, toSealedKeys(value), keysAad(serverId)),
        value,
      ]);
    }

    const plainLocalToken = readLocalStorageToken();

    await txMulti(db, [KEY_STORE, LOCK_STORE], "readwrite", (stores) => {
      for (const [serverId, sealed] of sealedNow) {
        stores[KEY_STORE]!.put(sealed, serverId);
      }
      if (plainLocalToken) {
        stores[LOCK_STORE]!.put(
          sealJson(mk, { token: plainLocalToken }, localTokenAad()),
          LOCAL_TOKEN_KEY,
        );
      }
      stores[LOCK_STORE]!.put(record, LOCK_KEY);
    });

    setMasterKey(mk);
    for (const [serverId, , plain] of sealedNow) cacheKeys(serverId, plain);
    if (plainLocalToken) {
      setLocalToken(plainLocalToken);
      // Only after the transaction has committed. Deleting first would risk
      // losing the token to an aborted write, and the credential is not
      // recoverable from anywhere else in the browser.
      clearLocalStorageToken();
    }
  } finally {
    db.close();
  }
}

/**
 * Add a passkey factor, wrapping the *same* master key.
 *
 * This is why there is no intermediate DEK layer: the only reason one usually
 * exists is rewrapping on factor change, and adding a factor here touches only
 * the wrapped-MK blobs. Nothing else is re-encrypted.
 */
export async function addFactor(
  kind: FactorRecord["kind"],
  factorKey: Uint8Array,
  options: { label?: string; iterations?: number; salt?: Uint8Array } = {},
): Promise<FactorRecord> {
  const record = await readLockRecord();
  if (!record) throw new Error("Set a PIN before adding another factor.");
  const mk = requireMasterKey();

  const id = factorId();
  const wrapped = await wrapMasterKey(factorKey, mk, kind, id);
  const factor: FactorRecord = {
    v: 1,
    kind,
    id,
    // A passkey's PRF output is already a 256-bit secret, so there is no
    // password to stretch and these fields are recorded as "not stretched"
    // rather than being quietly reused for something they do not describe.
    salt: options.salt ?? new Uint8Array(0),
    iterations: options.iterations ?? 0,
    wrapped,
    createdAt: Date.now(),
    ...(options.label ? { label: options.label } : {}),
  };

  await writeLockRecord({ ...record, factors: [...record.factors, factor] });
  return factor;
}

/**
 * Remove a factor.
 *
 * `requireMasterKey()` for the same reason `addFactor` has it: changing who can
 * open this device is a decision only the person who can already open it may
 * make. It was missing, and `/settings` — where this is reached — sat outside
 * `LockGate`, so a locked device could delete the passkey of the person holding
 * it and leave only the PIN they were trying to guess.
 *
 * The key is required and then unused, which is deliberate rather than sloppy:
 * nothing here is re-encrypted (that is the whole point of wrapping one master
 * key per factor), so the call is purely the authorisation check.
 */
export async function removeFactor(id: string): Promise<void> {
  const record = await readLockRecord();
  if (!record) return;
  requireMasterKey();
  const factors = record.factors.filter((f) => f.id !== id);
  // Removing the last factor would seal the keys under a master key nothing
  // can unwrap, which is indistinguishable from erasing them.
  if (factors.length === 0) {
    throw new Error(
      "That is the only way into this device. Erase the device instead.",
    );
  }
  await writeLockRecord({ ...record, factors });
}

/**
 * Verify a PIN and, on success, hand the master key to `unlocked.ts`.
 *
 * Verification *is* the GCM tag: a wrong PIN derives a wrong wrapping key,
 * which fails to authenticate the wrapped master key. There is no separate
 * verifier blob to get out of step with the real one.
 */
export async function unlockWithPin(pin: string): Promise<UnlockOutcome> {
  const record = await readLockRecord();
  if (!record) return { ok: false, reason: "no-lock" };

  const now = Date.now();
  if (record.lockedUntil && now < record.lockedUntil) {
    return { ok: false, reason: "throttled", until: record.lockedUntil };
  }

  const pinFactors = record.factors.filter((f) => f.kind === "pin");
  if (pinFactors.length === 0) return { ok: false, reason: "no-lock" };

  // Counted before the attempt, not after: otherwise killing the tab between
  // "wrong" and "write the counter" is a free guess, repeatable forever.
  const attempts = record.failedAttempts + 1;
  await writeLockRecord({
    ...record,
    failedAttempts: attempts,
    lockedUntil: lockoutUntil(attempts, now),
  });

  for (const factor of pinFactors) {
    const factorKey = await derivePinKey(pin, factor.salt, factor.iterations);
    try {
      const mk = await unwrapMasterKey(
        factorKey,
        factor.wrapped,
        factor.kind,
        factor.id,
      );
      await writeLockRecord({
        ...record,
        failedAttempts: 0,
        lockedUntil: null,
      });
      setMasterKey(mk);
      await restoreLocalToken(mk);
      return { ok: true };
    } catch {
      // Wrong PIN for this factor; try the next, then fall through.
    } finally {
      wipe(factorKey);
    }
  }

  if (record.wipeAfter10 && attempts >= WIPE_THRESHOLD) {
    await eraseDevice();
    return { ok: false, reason: "wiped" };
  }

  return {
    ok: false,
    reason: "wrong",
    attemptsLeft: record.wipeAfter10 ? WIPE_THRESHOLD - attempts : null,
  };
}

/** Unlock with a factor key that is already a 256-bit secret — i.e. a passkey PRF. */
export async function unlockWithFactorKey(
  factorId: string,
  factorKey: Uint8Array,
): Promise<UnlockOutcome> {
  const record = await readLockRecord();
  if (!record) return { ok: false, reason: "no-lock" };
  const factor = record.factors.find((f) => f.id === factorId);
  if (!factor) return { ok: false, reason: "no-lock" };

  try {
    const mk = await unwrapMasterKey(
      factorKey,
      factor.wrapped,
      factor.kind,
      factor.id,
    );
    // A passkey is not throttled — `userVerification: "required"` means the
    // authenticator already refused an unauthorised holder, and there is
    // nothing to guess.
    await writeLockRecord({ ...record, failedAttempts: 0, lockedUntil: null });
    setMasterKey(mk);
    await restoreLocalToken(mk);
    return { ok: true };
  } catch {
    return { ok: false, reason: "wrong", attemptsLeft: null };
  }
}

/**
 * Change how the lock behaves.
 *
 * Also gated, and it is not a lesser case than `removeFactor`: `wipeAfter10`
 * is reachable from here, so without the check someone holding a locked device
 * could switch erase-after-ten-wrong-PINs *on* and then deliberately fail ten
 * times — turning a lock screen into a destructive button. Turning the idle
 * timer to "Never" is the quieter version of the same problem.
 */
export async function updateLockSettings(
  patch: Partial<
    Pick<LockRecord, "wipeAfter10" | "idleMinutes" | "lockOnBackground">
  >,
): Promise<void> {
  const record = await readLockRecord();
  if (!record) return;
  requireMasterKey();
  await writeLockRecord({ ...record, ...patch });
}

// ---------------------------------------------------------------------------
// Per-session lock
// ---------------------------------------------------------------------------

/**
 * Sessions the user asked to be re-prompted for, stored *inside* the sealed
 * record.
 *
 * The list itself is the sensitive part. If it sat in a readable store, someone
 * holding a locked device could read off exactly which sessions were worth
 * protecting — which is most of the information they wanted.
 *
 * The UI calls this **"Require unlock to open"** and describes it as stopping
 * someone picking up your phone. Never "protected" and never "secured": this is
 * a client-side privacy control, and anyone with a devtools console on an
 * unlocked device can call `getRelayClient().send({type:"session:attach", …})`
 * directly. Moving it to relay enforcement later is adding a field to the
 * grant, not a redesign.
 */
/**
 * Which sessions on this machine are marked, read from the in-memory record.
 *
 * Only answerable while unlocked, which is correct: the answer is itself the
 * thing being protected.
 */
export function sessionLocks(serverId: string): Record<string, true> {
  return cachedKeys(serverId)?.sessionLocks ?? {};
}

export function isSessionLocked(
  serverId: string,
  sessionName: string,
): boolean {
  return sessionLocks(serverId)[sessionName] === true;
}

export async function setSessionLock(
  serverId: string,
  sessionName: string,
  locked: boolean,
): Promise<void> {
  const mk = requireMasterKey();
  const db = await openDb();
  try {
    const stored = await tx<KeyRecord | undefined>(
      db,
      KEY_STORE,
      "readonly",
      (store) => store.get(serverId),
    );
    if (!stored || !isSealed(stored)) {
      throw new Error("Set a device PIN before locking a session.");
    }
    const opened = fromSealedKeys(
      openJson<ReturnType<typeof toSealedKeys>>(mk, stored, keysAad(serverId)),
    );
    const sessionLocks = { ...(opened.sessionLocks ?? {}) };
    if (locked) sessionLocks[sessionName] = true;
    else delete sessionLocks[sessionName];

    const next: StoredKeys = { ...opened, sessionLocks };
    await tx(db, KEY_STORE, "readwrite", (store) =>
      store.put(sealJson(mk, toSealedKeys(next), keysAad(serverId)), serverId),
    );
    cacheKeys(serverId, next);
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// Erase
// ---------------------------------------------------------------------------

/**
 * Erase this device: every key, every descriptor, the lock, the cache, the
 * service worker and its caches.
 *
 * There is **no recovery**, by construction, and tmuxde is the rare product
 * where that is fine: signing in again takes only the relay token. That
 * sentence belongs in the enrollment dialog above the PIN entry, before the
 * first keystroke — not in a toast afterwards.
 */
export async function eraseDevice(): Promise<void> {
  forget();
  setEnrolled(false);
  try {
    const db = await openDb();
    // DESCRIPTOR_STORE belongs here and was missing: erasing the keys but
    // leaving the descriptors behind left the device holding a list of every
    // machine it had ever paired with — labels, tunnel ids and LAN addresses —
    // after being told it had been erased.
    await txMulti(
      db,
      [KEY_STORE, DESCRIPTOR_STORE, LOCK_STORE, CENSUS_STORE],
      "readwrite",
      (stores) => {
        for (const store of Object.values(stores)) store.clear();
      },
    );
    db.close();
  } catch {
    // Nothing to clear.
  }

  if (typeof window === "undefined") return;
  try {
    sessionStorage.clear();
  } catch {
    // Blocked storage. Nothing was there to clear either.
  }
  try {
    const registrations = await navigator.serviceWorker?.getRegistrations();
    await Promise.all((registrations ?? []).map((r) => r.unregister()));
    const keys = await caches?.keys();
    await Promise.all((keys ?? []).map((k) => caches.delete(k)));
  } catch {
    // No service worker, or a browser that will not say.
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function localTokenAad(): string {
  return recordAad("local-token", LOCAL_TOKEN_AAD_ID);
}

function readLocalStorageToken(): string | null {
  // Through `readStored`, so a browser still holding the pre-rename
  // `ccremote-token` gets sealed rather than silently left in the clear.
  return readStored(TOKEN_KEY);
}

function clearLocalStorageToken(): void {
  clearStored(TOKEN_KEY);
}

/** Bring the sealed self-hosted token back into memory after an unlock. */
async function restoreLocalToken(mk: Uint8Array): Promise<void> {
  try {
    const db = await openDb();
    const sealed = await tx<SealedRecord | undefined>(
      db,
      LOCK_STORE,
      "readonly",
      (store) => store.get(LOCAL_TOKEN_KEY),
    );
    db.close();
    if (!sealed) return;
    const { token } = openJson<{ token: string }>(mk, sealed, localTokenAad());
    setLocalToken(token);
  } catch {
    // No sealed token, or a tampered one. The hosted path does not use it.
  }
}

async function isEnrolledOnDisk(): Promise<boolean> {
  if (isEnrolled()) return true;
  return (await readLockRecord()) !== null;
}

function requireMasterKey(): Uint8Array {
  const mk = masterKey();
  if (!mk) throw new Error("This device is locked.");
  return mk;
}

function factorId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Exponential from the fourth attempt, capped at 15 minutes.
 *
 * The cap matters: an uncapped doubling reaches "come back tomorrow" by attempt
 * twenty, which punishes the owner far more than the attacker, who copied the
 * database and is not using this code path at all.
 */
export function lockoutUntil(attempts: number, now: number): number | null {
  if (attempts <= FREE_ATTEMPTS) return null;
  const step = attempts - FREE_ATTEMPTS;
  const delay = Math.min(1000 * 2 ** step, MAX_LOCKOUT_MS);
  return now + delay;
}

async function readAllKeyRecords(
  db: IDBDatabase,
): Promise<[string, KeyRecord][]> {
  const store = db.transaction(KEY_STORE, "readonly").objectStore(KEY_STORE);
  const [values, keys] = await Promise.all([
    request<KeyRecord[]>(store.getAll()),
    request<IDBValidKey[]>(store.getAllKeys()),
  ]);
  return keys.map((key, i) => [String(key), values[i]!] as [string, KeyRecord]);
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("indexedDB"));
  });
}
