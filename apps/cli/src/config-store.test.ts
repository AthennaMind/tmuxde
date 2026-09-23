import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, stat, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  verifyChallenge,
  newChallenge,
  signChallenge,
  deriveSessionKeys,
  encodeSessionKeys,
  decodeSessionKeys,
  randomBytes,
} from "@repo/crypto";

/**
 * config-store reads MTMUX_CONFIG_DIR at import time, so each test gets a
 * throwaway directory and a fresh module instance. Nothing here can touch the
 * developer's real ~/.mtmux.
 */
let dir: string;
let store: typeof import("./config-store.js");

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mtmux-cfg-"));
  process.env.MTMUX_CONFIG_DIR = dir;
  // The module reads MTMUX_CONFIG_DIR at import time, so the registry has to
  // be cleared for the new directory to take effect.
  vi.resetModules();
  store = await import("./config-store.js");
});

afterEach(async () => {
  delete process.env.MTMUX_CONFIG_DIR;
  await rm(dir, { recursive: true, force: true });
});

describe("token handling", () => {
  it("generates a 64-hex token on first load", async () => {
    const cfg = await store.load();
    expect(cfg.token).toMatch(/^[0-9a-f]{64}$/);
  });

  it("returns the same token on a second load", async () => {
    const first = await store.load();
    expect((await store.load()).token).toBe(first.token);
  });

  it("writes the config 0600 — it holds a token and a secret key", async () => {
    await store.load();
    const info = await stat(join(dir, "config.json"));
    expect(info.mode & 0o777).toBe(0o600);
  });

  it("honours an explicitly set token", async () => {
    await store.set("my-token");
    expect((await store.load()).token).toBe("my-token");
  });
});

describe("device identity", () => {
  it("creates a key on first use and reuses it after", async () => {
    const first = await store.ensureDeviceKey();
    expect(first.key.deviceId).toMatch(/^[0-9a-f]{16}$/);
    const second = await store.ensureDeviceKey();
    expect(second.key.deviceId).toBe(first.key.deviceId);
  });

  it("round-trips a key that can still sign", async () => {
    await store.ensureDeviceKey();
    const { key } = await store.ensureDeviceKey();
    const challenge = newChallenge();
    expect(
      verifyChallenge(
        key.publicKey,
        challenge,
        signChallenge(key.secretKey, challenge),
      ),
    ).toBe(true);
  });

  it("replaces a corrupted key rather than failing every command", async () => {
    const { key } = await store.ensureDeviceKey();
    const cfg = await store.load();
    await store.save({
      ...cfg,
      deviceKey: { deviceId: "0".repeat(16), publicKey: "aa", secretKey: "bb" },
    });
    const recovered = await store.ensureDeviceKey();
    expect(recovered.key.deviceId).not.toBe("0".repeat(16));
    expect(recovered.key.deviceId).not.toBe(key.deviceId);
  });

  it("survives a token rotation — rotating must not un-pair devices", async () => {
    const { key } = await store.ensureDeviceKey();
    await store.addPeer({
      deviceId: "peer1",
      publicKey: "",
      label: "iPhone",
      pairedAt: 1,
      lastSeenAt: 1,
    });

    const before = (await store.load()).token;
    const after = (await store.regenerate()).token;
    expect(after).not.toBe(before);

    const cfg = await store.load();
    expect(cfg.deviceKey?.deviceId).toBe(key.deviceId);
    expect(cfg.peers).toHaveLength(1);
  });
});

describe("peers", () => {
  const peer = (deviceId: string, label = "device") => ({
    deviceId,
    publicKey: "",
    label,
    pairedAt: 1000,
    lastSeenAt: 1000,
  });

  it("starts empty", async () => {
    expect(await store.listPeers()).toEqual([]);
  });

  it("adds and lists peers", async () => {
    await store.addPeer(peer("a", "iPhone"));
    await store.addPeer(peer("b", "iPad"));
    expect((await store.listPeers()).map((p) => p.label)).toEqual([
      "iPhone",
      "iPad",
    ]);
  });

  it("replaces a peer rather than duplicating it on re-pair", async () => {
    await store.addPeer(peer("a", "iPhone"));
    await store.addPeer(peer("a", "iPhone 16"));
    const peers = await store.listPeers();
    expect(peers).toHaveLength(1);
    expect(peers[0]?.label).toBe("iPhone 16");
  });

  it("revokes a peer and reports whether it existed", async () => {
    await store.addPeer(peer("a"));
    expect(await store.removePeer("a")).toBe(true);
    expect(await store.listPeers()).toEqual([]);
    expect(await store.removePeer("a")).toBe(false);
  });

  it("records last-seen time", async () => {
    await store.addPeer(peer("a"));
    await store.touchPeer("a", 5000);
    expect((await store.listPeers())[0]?.lastSeenAt).toBe(5000);
  });

  it("ignores a touch for an unknown peer", async () => {
    await expect(store.touchPeer("nope", 5000)).resolves.toBeUndefined();
  });

  it("round-trips a peer's tunnel key schedule through the file", async () => {
    // Without this the tunnel forgets every device on restart, while the LAN
    // path keeps working off `directToken` — the asymmetry that made the bug
    // read as a network fault.
    const keys = deriveSessionKeys(randomBytes(32), randomBytes(32));
    await store.addPeer({
      ...peer("a", "iPhone"),
      directToken: keys.directToken,
      sessionKeys: encodeSessionKeys(keys),
    });

    const stored = (await store.listPeers())[0]!;
    expect(decodeSessionKeys(stored.sessionKeys!).c2s).toEqual(keys.c2s);
  });

  it("keeps the key schedule 0600, like everything else in this file", async () => {
    const keys = deriveSessionKeys(randomBytes(32), randomBytes(32));
    await store.addPeer({
      ...peer("a"),
      sessionKeys: encodeSessionKeys(keys),
    });
    const info = await stat(join(dir, "config.json"));
    expect(info.mode & 0o077).toBe(0);
  });

  it("treats a peer idle for over 90 days as expired", () => {
    const now = 1_000_000_000_000;
    const fresh = { ...peer("a"), lastSeenAt: now - 1000 };
    const stale = { ...peer("b"), lastSeenAt: now - store.PEER_EXPIRY_MS - 1 };
    expect(store.isPeerExpired(fresh, now)).toBe(false);
    expect(store.isPeerExpired(stale, now)).toBe(true);
  });

  it("never writes the secret key in plain view of other users", async () => {
    await store.ensureDeviceKey();
    const info = await stat(join(dir, "config.json"));
    expect(info.mode & 0o077).toBe(0);
    // Sanity: it really is in there, so the permission check matters.
    const raw = await readFile(join(dir, "config.json"), "utf8");
    expect(raw).toContain("secretKey");
  });
});

describe("reconnect policy", () => {
  it("defaults to confirm, with or without a terminal", async () => {
    // This default used to depend on `process.stdout.isTTY`, which meant the
    // machines least likely to be watched were the ones that quietly stopped
    // asking. A headless box can still be asked — `mtmux approve` and the app
    // on a connected phone both work with no tty — so there is one default
    // now and it is the safe one.
    expect(await store.getReconnectPolicy()).toBe("confirm");
    expect(await store.getReconnectPolicy(true)).toBe("confirm");
    expect(await store.getReconnectPolicy(false)).toBe("confirm");
  });

  it("round-trips a stored policy", async () => {
    await store.setReconnectPolicy("confirm");
    expect(await store.getReconnectPolicy()).toBe("confirm");
    await store.setReconnectPolicy("trust");
    expect(await store.getReconnectPolicy()).toBe("trust");
  });

  it("falls back to the safe default when the file holds something else", async () => {
    const cfg = await store.load();
    await store.save({
      ...cfg,
      reconnectPolicy: "yes-please" as never,
    });
    expect(await store.getReconnectPolicy()).toBe("confirm");
  });

  it("keeps the token and peers when the policy changes", async () => {
    const before = await store.load();
    await store.addPeer(peerFixture("a", "iPhone"));
    await store.setReconnectPolicy("confirm");
    const after = await store.load();
    expect(after.token).toBe(before.token);
    expect(after.peers).toHaveLength(1);
  });

  it("recognises exactly two policies", () => {
    expect(store.isReconnectPolicy("trust")).toBe(true);
    expect(store.isReconnectPolicy("confirm")).toBe(true);
    expect(store.isReconnectPolicy("always")).toBe(false);
    expect(store.isReconnectPolicy(undefined)).toBe(false);
  });
});

/** The peer factory, hoisted out of the `peers` describe for reuse. */
function peerFixture(deviceId: string, label = "device") {
  return { deviceId, publicKey: "", label, pairedAt: 1000, lastSeenAt: 1000 };
}

/**
 * A name is for the reader, not for the device. It must never be able to
 * change what that device may do, and it must never destroy what the browser
 * actually claimed to be — which is the one field that can contradict it.
 */
describe("naming a paired device", () => {
  const peer = () => ({
    deviceId: "dev-1",
    publicKey: "",
    label: "Chrome on macOS",
    pairedAt: 1,
    lastSeenAt: 2,
  });

  it("names a device and keeps the browser's own claim", async () => {
    await store.addPeer(peer());
    expect(await store.renamePeer("dev-1", "Work laptop")).toBe(true);
    const [stored] = await store.listPeers();
    expect(stored!.name).toBe("Work laptop");
    expect(stored!.label).toBe("Chrome on macOS");
    expect(store.displayName(stored!)).toBe("Work laptop");
  });

  it("clears back to the browser's label", async () => {
    await store.addPeer({ ...peer(), name: "Work laptop" });
    await store.renamePeer("dev-1", null);
    const [stored] = await store.listPeers();
    expect(stored!.name).toBeUndefined();
    expect(store.displayName(stored!)).toBe("Chrome on macOS");
  });

  it("treats a name of only spaces as clearing it", async () => {
    await store.addPeer({ ...peer(), name: "Work laptop" });
    await store.renamePeer("dev-1", "   ");
    expect((await store.listPeers())[0]!.name).toBeUndefined();
  });

  it("caps the length the table has to draw", async () => {
    await store.addPeer(peer());
    await store.renamePeer("dev-1", "x".repeat(500));
    expect((await store.listPeers())[0]!.name).toHaveLength(
      store.MAX_PEER_NAME,
    );
  });

  it("changes nothing else about the record", async () => {
    await store.addPeer({ ...peer(), directToken: "t", grantId: "g" });
    await store.renamePeer("dev-1", "Work laptop");
    const [stored] = await store.listPeers();
    expect(stored!.directToken).toBe("t");
    expect(stored!.grantId).toBe("g");
  });

  it("says so rather than inventing a peer that is not there", async () => {
    expect(await store.renamePeer("nobody", "x")).toBe(false);
  });
});
