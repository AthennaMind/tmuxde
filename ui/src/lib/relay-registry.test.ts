import { describe, it, expect, beforeEach } from "vitest";
import type { RelayClient } from "./ws-client";
import {
  acquire,
  get,
  getActive,
  getActiveServerId,
  heldServerIds,
  release,
  resetRegistry,
  setActive,
} from "./relay-registry";

/** A RelayClient stand-in: the registry only ever calls `disconnect`. */
function fakeClient(): RelayClient & { disconnects: number } {
  const client = {
    disconnects: 0,
    disconnect() {
      client.disconnects += 1;
    },
  };
  return client as unknown as RelayClient & { disconnects: number };
}

describe("relay registry", () => {
  beforeEach(() => resetRegistry());

  it("creates a client once and hands the same one back", () => {
    let built = 0;
    const create = () => {
      built += 1;
      return fakeClient();
    };

    const first = acquire("aa", create, "k");
    const second = acquire("aa", create, "k");

    expect(built).toBe(1);
    expect(second).toBe(first);
  });

  it("keeps the connection alive until the last holder lets go", () => {
    const client = fakeClient();
    acquire("aa", () => client, "k");
    acquire("aa", () => client, "k");

    release("aa");
    // This is the StrictMode case: the second mount's teardown must not close
    // the socket the first one is still using.
    expect(client.disconnects).toBe(0);
    expect(get("aa")).toBe(client);

    release("aa");
    expect(client.disconnects).toBe(1);
    expect(get("aa")).toBeNull();
  });

  it("ignores a release for something that was never acquired", () => {
    expect(() => release("nope")).not.toThrow();
  });

  it("replaces the client when the same machine is reached a different way", () => {
    const direct = fakeClient();
    const tunnel = fakeClient();

    acquire("aa", () => direct, "ws://lan/_relay");
    const second = acquire("aa", () => tunnel, "wss://api/v1/tunnel/x");

    expect(second).toBe(tunnel);
    expect(direct.disconnects).toBe(1);
    expect(get("aa")).toBe(tunnel);
  });

  it("keeps machines apart", () => {
    const a = fakeClient();
    const b = fakeClient();
    acquire("aa", () => a, "k");
    acquire("bb", () => b, "k");

    expect(heldServerIds().sort()).toEqual(["aa", "bb"]);
    release("aa");
    expect(a.disconnects).toBe(1);
    expect(b.disconnects).toBe(0);
    expect(get("bb")).toBe(b);
  });

  it("resolves the active client, and forgets it when it goes away", () => {
    const a = fakeClient();
    acquire("aa", () => a, "k");
    setActive("aa");

    expect(getActive()).toBe(a);
    expect(getActiveServerId()).toBe("aa");

    release("aa");
    // A stale active id would make `getRelayClient()` answer with a
    // disconnected client forever.
    expect(getActive()).toBeNull();
    expect(getActiveServerId()).toBeNull();
  });

  it("has no active client before anything connects", () => {
    expect(getActive()).toBeNull();
    setActive("never-acquired");
    expect(getActive()).toBeNull();
  });
});
