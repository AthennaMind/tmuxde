import { describe, it, expect, afterEach } from "vitest";
import { setConnectionGate, admitConnection } from "./connection-gate.js";

const REQUEST = {
  tokenId: "abc",
  deviceId: "device-1",
  label: "iPhone",
  transport: "tunnel" as const,
  userAgent: "Mozilla/5.0",
};

afterEach(() => setConnectionGate(null));

/**
 * The door every socket walks through, and the three answers it can get.
 *
 * Approval used to happen once per credential, at pairing time, and never
 * again — so a browser approved in March came back in June, from a network
 * nobody recognised, in silence. This is the check that made that impossible,
 * and its defaults are the whole of its safety argument.
 */
describe("the connection gate", () => {
  it("admits when nothing is installed to ask", async () => {
    // The standalone relay has no terminal. Failing closed there would be a
    // relay that refuses every connection because nobody wired a prompt.
    expect(await admitConnection(REQUEST)).toBe(true);
  });

  it("passes the socket's details to whoever is asking", async () => {
    const seen: unknown[] = [];
    setConnectionGate(async (req) => {
      seen.push(req);
      return true;
    });
    await admitConnection(REQUEST);
    expect(seen).toEqual([REQUEST]);
  });

  it("refuses when the gate says no", async () => {
    setConnectionGate(async () => false);
    expect(await admitConnection(REQUEST)).toBe(false);
  });

  it("treats a gate that throws as a refusal", async () => {
    // "I could not ask" is not a yes, here or anywhere else in this product.
    setConnectionGate(async () => {
      throw new Error("the panel has gone");
    });
    expect(await admitConnection(REQUEST)).toBe(false);
  });

  it("stops asking once the gate is taken down", async () => {
    setConnectionGate(async () => false);
    setConnectionGate(null);
    expect(await admitConnection(REQUEST)).toBe(true);
  });
});
