import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/features/connection/use-websocket", () => ({ getRelayClient: () => null }));

import { enrollPin, eraseDevice, unlockWithPin } from "./lock-store";
import { disconnectDevice } from "./sign-out";
import { readSelfHostedToken } from "@/features/connection/storage-keys";
import { forget } from "./unlocked";

/**
 * Disconnect, the sign out in Settings, against a real IndexedDB.
 *
 * It had no caller and no test. On a device with a lock it also left the
 * sealed token behind, so the next unlock signed the browser back in.
 */

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

const assign = vi.fn();

beforeEach(async () => {
  assign.mockReset();
  const local = memoryStorage();
  const session = memoryStorage();
  vi.stubGlobal("window", {
    location: { assign },
    localStorage: local,
    sessionStorage: session,
  });
  vi.stubGlobal("localStorage", local);
  vi.stubGlobal("sessionStorage", session);
  await eraseDevice();
  forget();
});

describe("disconnectDevice", () => {
  it("drops the token and the last session, then goes to /login", async () => {
    localStorage.setItem("tmuxde-token", "self-hosted-secret");
    localStorage.setItem("tmuxde-last-session", "work");

    await disconnectDevice();

    expect(readSelfHostedToken()).toBeNull();
    expect(localStorage.getItem("tmuxde-last-session")).toBeNull();
    expect(assign).toHaveBeenCalledWith("/login");
  });

  it("stays signed out across an unlock on a device with a lock", async () => {
    localStorage.setItem("tmuxde-token", "self-hosted-secret");
    await enrollPin("123456");
    expect(readSelfHostedToken()).toBe("self-hosted-secret");

    await disconnectDevice();
    forget();
    await unlockWithPin("123456");

    expect(readSelfHostedToken()).toBeNull();
  });
});
