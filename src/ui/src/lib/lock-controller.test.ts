import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  ceremonyInProgress,
  duringCeremony,
  lockNow,
  registerDisconnect,
} from "./lock-controller";
import { forget, isUnlocked, setEnrolled, setMasterKey } from "./unlocked";

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

beforeEach(() => {
  vi.stubGlobal("localStorage", memoryStorage());
  vi.stubGlobal("sessionStorage", memoryStorage());
  vi.stubGlobal("window", { sessionStorage: memoryStorage() });
  forget();
  setEnrolled(false);
  registerDisconnect(null);
});

describe("lockNow", () => {
  it("drops the socket before wiping the keys", () => {
    // The sealed transport holds the same Uint8Arrays `forget()` zeroes. Wipe
    // first and a queued frame goes out under a key of zeroes.
    const order: string[] = [];
    registerDisconnect(() => order.push("disconnect"));
    setEnrolled(true);
    setMasterKey(new Uint8Array(32).fill(7));

    lockNow("manual");

    expect(order).toEqual(["disconnect"]);
    expect(isUnlocked()).toBe(false);
  });

  it("does nothing on a device with no lock", () => {
    const disconnect = vi.fn();
    registerDisconnect(disconnect);
    lockNow("manual");
    expect(disconnect).not.toHaveBeenCalled();
  });

  it("survives a disconnect that throws", () => {
    registerDisconnect(() => {
      throw new Error("socket already gone");
    });
    setEnrolled(true);
    setMasterKey(new Uint8Array(32));

    expect(() => lockNow("manual")).not.toThrow();
    expect(isUnlocked()).toBe(false);
  });
});

describe("ceremony suppression", () => {
  it("is on for the whole ceremony and a moment after", async () => {
    vi.useFakeTimers();
    expect(ceremonyInProgress()).toBe(false);

    const pending = duringCeremony(async () => "done");
    expect(ceremonyInProgress()).toBe(true);
    await pending;
    // Still suppressed: iOS delivers the visibility event for dismissing the
    // system sheet *after* the promise settles, which is precisely the event
    // that would otherwise lock the device mid-unlock.
    expect(ceremonyInProgress()).toBe(true);

    vi.advanceTimersByTime(2000);
    expect(ceremonyInProgress()).toBe(false);
    vi.useRealTimers();
  });

  it("clears even when the ceremony fails", async () => {
    vi.useFakeTimers();
    await expect(
      duringCeremony(async () => {
        throw new Error("cancelled");
      }),
    ).rejects.toThrow();
    vi.advanceTimersByTime(2000);
    expect(ceremonyInProgress()).toBe(false);
    vi.useRealTimers();
  });
});
