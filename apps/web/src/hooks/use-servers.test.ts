import { describe, it, expect } from "vitest";
import { normalizeServer } from "./use-servers";

/**
 * The normalizer, which is the part of this hook worth pinning.
 *
 * There used to be two of these — one in `all-sessions.tsx` and one in
 * the since-deleted `server-list.tsx` — reading the same `GET /v1/servers`. Two
 * requests for one
 * answer was the small problem; two different shapes for it was the real one,
 * because a machine could read as online in one list and offline in the other.
 */
describe("normalizeServer", () => {
  it("keeps everything the broker sent", () => {
    expect(
      normalizeServer({
        id: "srv_1",
        name: "thinkpad",
        slug: "thinkpad",
        publicKey: "ab".repeat(32),
        online: true,
        lastSeenAt: 1_700_000_000_000,
        platform: "linux-x64",
        cliVersion: "0.6.0",
      }),
    ).toEqual({
      id: "srv_1",
      name: "thinkpad",
      slug: "thinkpad",
      publicKey: "ab".repeat(32),
      online: true,
      lastSeenAt: 1_700_000_000_000,
      platform: "linux-x64",
      cliVersion: "0.6.0",
    });
  });

  it("names a machine that arrived without one", () => {
    // "Unnamed machine" rather than an empty heading, which reads as a bug.
    expect(normalizeServer({ id: "srv_1" }).name).toBe("Unnamed machine");
    expect(normalizeServer({ id: "srv_1", name: "" }).name).toBe(
      "Unnamed machine",
    );
  });

  it("treats anything but a literal true as offline", () => {
    // The dot and the "Pair this device" button both hang off this, and an
    // offline machine cannot be asked anything — the request travels over its
    // own tunnel.
    for (const online of [undefined, null, "true", 1, {}]) {
      expect(normalizeServer({ id: "x", online }).online).toBe(false);
    }
    expect(normalizeServer({ id: "x", online: true }).online).toBe(true);
  });

  it("nulls a version it cannot read, rather than inventing one", () => {
    // `cliVersion` gates an "update to pair" affordance, and a fabricated
    // value would show it to someone who is already current.
    expect(normalizeServer({ id: "x" }).cliVersion).toBeNull();
    expect(normalizeServer({ id: "x", cliVersion: 6 }).cliVersion).toBeNull();
    expect(normalizeServer({ id: "x", cliVersion: "0.6.0" }).cliVersion).toBe(
      "0.6.0",
    );
  });

  it("accepts an ISO timestamp as well as epoch ms", () => {
    const iso = "2026-07-31T14:05:09.000Z";
    expect(normalizeServer({ id: "x", lastSeenAt: iso }).lastSeenAt).toBe(
      Date.parse(iso),
    );
  });
});
