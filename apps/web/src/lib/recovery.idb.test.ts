import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SealedDescriptor } from "@repo/protocol";
import type { SessionKeys } from "@repo/crypto";

import { persistPairing } from "./persist-pairing";
import * as candidateRace from "./candidate-race";
import { eraseDevice } from "./lock-store";
import { forgetActiveSession } from "./forget-session";
import { resolveRoute } from "./resolve-route";
import { loadDescriptor, loadSessionKeys, serverIdFor } from "./session-store";
import { forget } from "./unlocked";

/**
 * Getting unstuck, against a real IndexedDB.
 *
 * Two behaviours that did not exist: re-deciding a route that was previously
 * fixed at pairing time, and being able to throw a pairing away at all. Both
 * are the difference between a session that recovers and one that shows
 * "Reconnecting…" until the user clears site data.
 */

const DESCRIPTOR: SealedDescriptor = {
  candidates: ["http://192.168.1.5:14100"],
  tunnelId: "tnl-abcdefgh",
  deviceId: "0".repeat(16),
  publicKey: "1".repeat(64),
  label: "gagan@thinkpad",
};

function keys(): SessionKeys {
  return {
    c2s: new Uint8Array([1, 2, 3, 4]),
    s2c: new Uint8Array([5, 6, 7, 8]),
    confirm: new Uint8Array([9, 10]),
    directToken: "tok-1",
  };
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

/** Pair, with the race decided for us. */
async function pairedWith(winner: string | null) {
  vi.spyOn(candidateRace, "raceCandidates").mockResolvedValue({
    winner,
    elapsedMs: 10,
  });
  await persistPairing({ keys: keys(), descriptor: DESCRIPTOR });
}

beforeEach(async () => {
  const session = memoryStorage();
  vi.stubGlobal("window", {
    sessionStorage: session,
    location: { origin: "http://192.168.1.5:14100", protocol: "http:" },
  });
  vi.stubGlobal("sessionStorage", session);
  vi.stubGlobal("localStorage", memoryStorage());
  vi.restoreAllMocks();
  await eraseDevice();
  forget();
});

describe("resolveRoute", () => {
  it("never probes a saved foreign machine", async () => {
    await pairedWith("http://192.168.1.5:14100");
    vi.stubGlobal("window", {
      location: { origin: "https://terminal.local", protocol: "https:" },
    });
    const probe = vi
      .spyOn(candidateRace, "raceCandidates")
      .mockResolvedValue({ winner: null, elapsedMs: 0 });
    const route = await resolveRoute(loadDescriptor()!, keys());
    expect(probe).toHaveBeenCalledWith([], "tok-1");
    expect(route.preferredCandidate).toBeNull();
    expect(await loadSessionKeys(serverIdFor(DESCRIPTOR))).not.toBeNull();
  });

  it("clears a preference that no longer answers", async () => {
    // The phone paired at home…
    await pairedWith("http://192.168.1.5:14100");
    expect(loadDescriptor()?.preferredCandidate).toBe(
      "http://192.168.1.5:14100",
    );

    // …and then left the house. Before this, the stored preference was never
    // revisited and the tunnel was never tried.
    vi.spyOn(candidateRace, "raceCandidates").mockResolvedValue({
      winner: null,
      elapsedMs: 800,
    });
    const route = await resolveRoute(loadDescriptor()!, keys());

    expect(route.preferredCandidate).toBeNull();
    expect(loadDescriptor()?.preferredCandidate).toBeUndefined();
  });

  it("does not open a hosted tunnel when an old broker setting is present", async () => {
    await pairedWith("http://192.168.1.5:14100");

    // Obsolete broker configuration must not enable network fallback.
    process.env.NEXT_PUBLIC_API_URL = "https://api.mtmux.com";
    vi.resetModules();
    try {
      const race = await import("./candidate-race");
      vi.spyOn(race, "raceCandidates").mockResolvedValue({
        winner: null,
        elapsedMs: 800,
      });
      const hosted = await import("./resolve-route");
      const store = await import("./session-store");

      const route = await hosted.resolveRoute(store.loadDescriptor()!, keys());

      expect(route.preferredCandidate).toBeNull();
      expect(route.transport).toBeUndefined();
    } finally {
      delete process.env.NEXT_PUBLIC_API_URL;
      vi.resetModules();
    }
  });

  it("records a direct win and asks for no tunnel transport", async () => {
    await pairedWith(null);

    vi.spyOn(candidateRace, "raceCandidates").mockResolvedValue({
      winner: "http://192.168.1.5:14100",
      elapsedMs: 20,
    });
    const route = await resolveRoute(loadDescriptor()!, keys());

    expect(route.preferredCandidate).toBe("http://192.168.1.5:14100");
    expect(route.transport).toBeUndefined();
    expect(loadDescriptor()?.preferredCandidate).toBe(
      "http://192.168.1.5:14100",
    );
  });

  it("leaves the record alone when the answer has not changed", async () => {
    await pairedWith("http://192.168.1.5:14100");
    const before = loadDescriptor();

    vi.spyOn(candidateRace, "raceCandidates").mockResolvedValue({
      winner: "http://192.168.1.5:14100",
      elapsedMs: 20,
    });
    await resolveRoute(before!, keys());

    expect(loadDescriptor()).toEqual(before);
  });
});

describe("forgetActiveSession", () => {
  it("drops the descriptor and the keys together", async () => {
    await pairedWith(null);
    const serverId = serverIdFor(DESCRIPTOR);
    expect(await loadSessionKeys(serverId)).not.toBeNull();

    await forgetActiveSession();

    expect(loadDescriptor()).toBeNull();
    // The half that is easy to forget: keys left behind belong to a machine
    // the user has said they are done with.
    expect(await loadSessionKeys(serverId)).toBeNull();
  });

  it("is safe to call with nothing paired", async () => {
    await expect(forgetActiveSession()).resolves.toBeUndefined();
    expect(loadDescriptor()).toBeNull();
  });
});
