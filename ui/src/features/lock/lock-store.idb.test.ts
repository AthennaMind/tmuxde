import { beforeEach, describe, expect, it, vi } from "vitest";
import { openJson, type SealedRecord } from "@/shared/crypto";

import {
  enrollPin,
  eraseDevice,
  forgetSealedLocalToken,
  isSessionLocked,
  lockoutUntil,
  readLockRecord,
  removeFactor,
  setSessionLock,
  unlockWithPin,
  updateLockSettings,
} from "./lock-store";
import {
  KEY_STORE,
  isSealed,
  keysAad,
  loadSessionKeys,
  openDb,
  saveSessionKeys,
  tx,
  type KeyRecord,
} from "./session-key-store";
import { forget, isEnrolled, isUnlocked, masterKey, subscribeLock } from "./unlocked";
import { readSelfHostedToken } from "@/features/connection/storage-keys";

/**
 * The lock, against a real IndexedDB implementation.
 *
 * These live in their own vitest project because they do genuine PBKDF2 and
 * would otherwise be the slowest thing in the fast suite. `fake-indexeddb/auto`
 * runs in the node environment, so no jsdom is dragged in.
 */

const SERVER = "device-abc";

function keys(directToken = "tok-1") {
  return {
    c2s: new Uint8Array([1, 2, 3, 4]),
    s2c: new Uint8Array([5, 6, 7, 8]),
    confirm: new Uint8Array([9, 10]),
    directToken,
  };
}

async function readRaw(serverId: string): Promise<KeyRecord | undefined> {
  const db = await openDb();
  const value = await tx<KeyRecord | undefined>(db, KEY_STORE, "readonly", (store) =>
    store.get(serverId),
  );
  db.close();
  return value;
}

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k: string) => map.get(k) ?? null,
    key: (i: number) => Array.from(map.keys())[i] ?? null,
    removeItem: (k: string) => void map.delete(k),
    setItem: (k: string, v: string) => void map.set(k, v),
  };
}

beforeEach(async () => {
  vi.stubGlobal("window", { localStorage: memoryStorage() });
  vi.stubGlobal("localStorage", memoryStorage());
  // Mocks first: the abort test replaces `IDBDatabase.transaction`, and
  // `eraseDevice` is itself a multi-store transaction that the replacement
  // would abort.
  vi.restoreAllMocks();
  await eraseDevice();
  forget();
});

describe("enrollment", () => {
  it("seals every existing key record and leaves nothing in the clear", async () => {
    await saveSessionKeys(SERVER, keys());
    expect(isSealed(await readRaw(SERVER))).toBe(false);

    await enrollPin("123456");

    const raw = await readRaw(SERVER);
    expect(isSealed(raw)).toBe(true);
    // The whole point: the token must not be readable from the stored bytes.
    expect(JSON.stringify(raw)).not.toContain("tok-1");
  });

  it("keeps the keys usable straight afterwards", async () => {
    await saveSessionKeys(SERVER, keys());
    await enrollPin("123456");

    const loaded = await loadSessionKeys(SERVER);
    expect(loaded?.directToken).toBe("tok-1");
    expect(Array.from(loaded!.c2s)).toEqual([1, 2, 3, 4]);
  });

  it("seals records written after enrollment too", async () => {
    await enrollPin("123456");
    await saveSessionKeys("device-later", keys("tok-2"));
    expect(isSealed(await readRaw("device-later"))).toBe(true);
  });

  it("leaves the database untouched when the transaction aborts", async () => {
    await saveSessionKeys(SERVER, keys());

    // Force the commit to fail partway. Either everything happened or nothing
    // did — a half-sealed key store is a device that cannot reach its own keys,
    // which is the failure this single transaction exists to make impossible.
    const real = IDBDatabase.prototype.transaction;
    vi.spyOn(IDBDatabase.prototype, "transaction").mockImplementation(function (
      this: IDBDatabase,
      names: string | Iterable<string>,
      ...rest: unknown[]
    ) {
      const transaction = real.apply(this, [names, ...rest] as unknown as Parameters<typeof real>);
      if (typeof names !== "string" && [...names].length > 1) {
        queueMicrotask(() => transaction.abort());
      }
      return transaction;
    });

    await expect(enrollPin("123456")).rejects.toThrow();
    vi.restoreAllMocks();

    expect(isSealed(await readRaw(SERVER))).toBe(false);
    expect(await readLockRecord()).toBeNull();
  });

  it("refuses a second enrollment rather than orphaning the first", async () => {
    await enrollPin("123456");
    await expect(enrollPin("999999")).rejects.toThrow();
  });
});

describe("unlocking", () => {
  it("opens with the right PIN and stays shut with the wrong one", async () => {
    await saveSessionKeys(SERVER, keys());
    await enrollPin("123456");
    forget();

    expect(await unlockWithPin("000000")).toMatchObject({ ok: false });
    expect(masterKey()).toBeNull();

    expect(await unlockWithPin("123456")).toEqual({ ok: true });
    expect(isUnlocked()).toBe(true);
  });

  it("returns null for sealed keys while locked, rather than throwing", async () => {
    await saveSessionKeys(SERVER, keys());
    await enrollPin("123456");
    forget();

    expect(await loadSessionKeys(SERVER)).toBeNull();
  });

  it("counts the attempt before verifying, so killing the tab is not a free guess", async () => {
    await enrollPin("123456");
    forget();

    await unlockWithPin("000000");
    expect((await readLockRecord())?.failedAttempts).toBe(1);
  });

  it("clears the counter on success", async () => {
    await enrollPin("123456");
    forget();
    await unlockWithPin("000000");
    await unlockWithPin("123456");
    expect((await readLockRecord())?.failedAttempts).toBe(0);
  });

  it("throttles rather than allowing unlimited guesses", async () => {
    await enrollPin("123456");
    forget();
    for (let i = 0; i < 4; i += 1) await unlockWithPin("000000");

    const outcome = await unlockWithPin("000000");
    expect(outcome).toMatchObject({ ok: false, reason: "throttled" });
    // Even the correct PIN waits — otherwise the throttle is advisory.
    expect(await unlockWithPin("123456")).toMatchObject({
      reason: "throttled",
    });
  });

  it("is off by default for wiping, so ten mistakes are recoverable", async () => {
    await enrollPin("123456");
    expect((await readLockRecord())?.wipeAfter10).toBe(false);
  });
});

describe("lockoutUntil", () => {
  it("gives three free attempts, then doubles, then caps", () => {
    expect(lockoutUntil(1, 0)).toBeNull();
    expect(lockoutUntil(3, 0)).toBeNull();
    expect(lockoutUntil(4, 0)).toBe(2_000);
    expect(lockoutUntil(5, 0)).toBe(4_000);
    // The cap matters: uncapped doubling reaches "come back tomorrow" and
    // punishes the owner, not the attacker with a copy of the database.
    expect(lockoutUntil(40, 0)).toBe(15 * 60_000);
  });
});

describe("per-session lock", () => {
  it("stores the flag inside the sealed record, never beside it", async () => {
    await saveSessionKeys(SERVER, keys());
    await enrollPin("123456");
    await setSessionLock(SERVER, "prod", true);

    const raw = await readRaw(SERVER);
    expect(isSealed(raw)).toBe(true);
    // The list of which sessions are marked is itself the sensitive part.
    expect(JSON.stringify(raw)).not.toContain("prod");

    const opened = openJson<{ sessionLocks?: Record<string, true> }>(
      masterKey()!,
      raw as SealedRecord,
      keysAad(SERVER),
    );
    expect(opened.sessionLocks).toEqual({ prod: true });
    expect(isSessionLocked(SERVER, "prod")).toBe(true);
  });

  it("unsets cleanly", async () => {
    await saveSessionKeys(SERVER, keys());
    await enrollPin("123456");
    await setSessionLock(SERVER, "prod", true);
    await setSessionLock(SERVER, "prod", false);
    expect(isSessionLocked(SERVER, "prod")).toBe(false);
  });

  it("survives a lock and unlock", async () => {
    await saveSessionKeys(SERVER, keys());
    await enrollPin("123456");
    await setSessionLock(SERVER, "prod", true);

    forget();
    await unlockWithPin("123456");
    await loadSessionKeys(SERVER);

    expect(isSessionLocked(SERVER, "prod")).toBe(true);
  });
});

describe("the self-hosted token", () => {
  it("moves out of localStorage on enrollment and comes back on unlock", async () => {
    // On the self-hosted path this is a *working credential* sitting in a
    // store any script on the origin can read, surviving a lock that encrypts
    // everything else.
    localStorage.setItem("tmuxde-token", "self-hosted-secret");

    await enrollPin("123456");
    expect(localStorage.getItem("tmuxde-token")).toBeNull();
    expect(readSelfHostedToken()).toBe("self-hosted-secret");

    forget();
    expect(readSelfHostedToken()).toBeNull();

    await unlockWithPin("123456");
    expect(readSelfHostedToken()).toBe("self-hosted-secret");
  });

  it("is back before the unlock is announced", async () => {
    // The announce opens the lock gate, and the terminal layout reads the
    // token as it mounts. Without it there, the layout sends the device to
    // the login page.
    localStorage.setItem("tmuxde-token", "self-hosted-secret");
    await enrollPin("123456");
    forget();

    const seen: (string | null)[] = [];
    const stop = subscribeLock((state) => {
      if (state.unlocked) seen.push(readSelfHostedToken());
    });
    try {
      await unlockWithPin("123456");
    } finally {
      stop();
    }
    expect(seen).toEqual(["self-hosted-secret"]);
  });

  it("stays signed out after a sign out and an unlock", async () => {
    // A sign out on a device with a lock dropped the plaintext and the
    // in-memory copy, and the next unlock brought the sealed one back.
    localStorage.setItem("tmuxde-token", "self-hosted-secret");
    await enrollPin("123456");

    await forgetSealedLocalToken();
    forget();
    await unlockWithPin("123456");

    expect(readSelfHostedToken()).toBeNull();
  });

  it("leaves localStorage alone on a device with no lock", async () => {
    localStorage.setItem("tmuxde-token", "self-hosted-secret");
    expect(readSelfHostedToken()).toBe("self-hosted-secret");
    expect(localStorage.getItem("tmuxde-token")).toBe("self-hosted-secret");
  });
});

describe("eraseDevice", () => {
  it("leaves nothing behind", async () => {
    await saveSessionKeys(SERVER, keys());
    await enrollPin("123456");

    await eraseDevice();

    expect(await readLockRecord()).toBeNull();
    expect(await readRaw(SERVER)).toBeUndefined();
    expect(isEnrolled()).toBe(false);
    expect(isUnlocked()).toBe(false);
  });

  it("forgets the last session name", async () => {
    // The erase dialog promises every cached session list goes. The name
    // also made the next visit open a session that may be gone.
    localStorage.setItem("tmuxde-last-session", "deploy-prod");

    await eraseDevice();

    expect(localStorage.getItem("tmuxde-last-session")).toBeNull();
  });
});

/**
 * The two holes a locked device could reach through `/settings`, which sat
 * outside `LockGate` until this was fixed.
 *
 * Both assertions matter, and the second is the one that would catch a
 * regression written in good faith: a check that throws *after* writing has
 * already happened is worse than no check, because it looks correct in the UI
 * and leaves the record changed.
 */
describe("locked-device mutations", () => {
  it("refuses to remove a factor, and changes nothing", async () => {
    await enrollPin("123456");
    const before = await readLockRecord();
    const factorId = before!.factors[0]!.id;
    forget(); // lock, keeping the enrolled state on disk

    await expect(removeFactor(factorId)).rejects.toThrow(/locked/i);

    expect(await readLockRecord()).toEqual(before);
  });

  it("refuses to change lock settings, and changes nothing", async () => {
    await enrollPin("123456");
    const before = await readLockRecord();
    expect(before!.wipeAfter10).toBe(false);
    forget();

    await expect(updateLockSettings({ wipeAfter10: true })).rejects.toThrow(/locked/i);

    expect(await readLockRecord()).toEqual(before);
  });

  it("still allows both once unlocked", async () => {
    await enrollPin("123456");
    forget();
    await unlockWithPin("123456");

    await updateLockSettings({ wipeAfter10: true });
    expect((await readLockRecord())!.wipeAfter10).toBe(true);
  });

  /**
   * The regression guard for keeping `eraseDevice` master-key-free. It is
   * called from the failed-unlock wipe path, where by definition no master key
   * exists — so "gate it like the others" would silently disable the wipe.
   */
  it("still erases on the wipe path, where there is no master key", async () => {
    await saveSessionKeys(SERVER, keys());
    await enrollPin("123456");
    await updateLockSettings({ wipeAfter10: true });
    forget();

    // The throttle bites from the fourth attempt, so reaching ten means
    // sitting out each lockout. An attacker with the database has all the time
    // in the world, which is exactly why the wipe exists at all.
    let skew = 0;
    const realNow = Date.now.bind(Date);
    vi.spyOn(Date, "now").mockImplementation(() => realNow() + skew);

    let outcome;
    for (let i = 0; i < 10; i += 1) {
      outcome = await unlockWithPin("000000");
      const until = (await readLockRecord())?.lockedUntil;
      if (until) skew = until - realNow() + 1;
    }

    expect(outcome).toEqual({ ok: false, reason: "wiped" });
    expect(await readLockRecord()).toBeNull();
    expect(await readRaw(SERVER)).toBeUndefined();
  });
});

/**
 * A locked device must not be able to write plaintext keys.
 *
 * `/pair` and `/j` are outside `LockGate` on purpose — they are how a locked
 * device would re-pair — so `saveSessionKeys` is genuinely reachable while
 * locked. It used to hand back the unsealed record, which meant one re-pair
 * downgraded the lock to decorative.
 */
describe("pairing on a locked device", () => {
  it("throws rather than writing keys in the clear", async () => {
    await enrollPin("123456");
    forget();

    await expect(saveSessionKeys("device-new", keys())).rejects.toThrow(/locked/i);

    expect(await readRaw("device-new")).toBeUndefined();
  });

  it("seals normally once unlocked", async () => {
    await enrollPin("123456");
    forget();
    await unlockWithPin("123456");

    await saveSessionKeys("device-new", keys("tok-2"));

    expect(isSealed(await readRaw("device-new"))).toBe(true);
    expect((await loadSessionKeys("device-new"))!.directToken).toBe("tok-2");
  });
});
