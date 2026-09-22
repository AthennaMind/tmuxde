import { describe, it, expect, beforeEach } from "vitest";
import {
  armLocalPairing,
  disarmLocalPairing,
  redeemLocalPairing,
  setLocalPairingGate,
  onLocalPairingSpent,
  issueSessionToken,
  isValidSessionToken,
  revokeSessionToken,
  hasLivePairingNonce,
  resetPairingState,
  registerSessionToken,
  labelForToken,
  grantForToken,
  onSessionTokenUsed,
  onSessionTokenRevoked,
  revokeGrant,
  sessionTokenId,
} from "./pairing-local.js";
import { FULL_GRANT } from "./grant.js";

const T0 = 1_700_000_000_000;

describe("local pairing offers", () => {
  beforeEach(resetPairingState);

  const CODE = "483921";
  const redeemNonce = (nonce: string, now = T0) =>
    redeemLocalPairing({ nonce }, {}, now);
  const redeemCode = (code: string, now = T0) =>
    redeemLocalPairing({ code }, {}, now);

  it("is disarmed until an offer is armed", async () => {
    expect(hasLivePairingNonce(T0)).toBe(false);
    expect(await redeemNonce("anything")).toEqual({
      ok: false,
      reason: "invalid",
    });
    expect(await redeemCode(CODE)).toEqual({ ok: false, reason: "invalid" });
  });

  it("redeems a fresh nonce for a session token", async () => {
    const { nonce } = armLocalPairing(CODE, 60_000, T0);
    const result = await redeemNonce(nonce);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.session.token).toMatch(/^[0-9a-f]{64}$/);
    expect(result.session.expiresAt).toBeGreaterThan(T0);
  });

  it("redeems the typed code for a session token", async () => {
    armLocalPairing(CODE, 60_000, T0);
    expect((await redeemCode(CODE)).ok).toBe(true);
  });

  it("accepts the code however it was spaced", async () => {
    armLocalPairing(CODE, 60_000, T0);
    expect((await redeemCode("483 921")).ok).toBe(true);
  });

  it("burns the offer — a second redemption fails", async () => {
    const { nonce } = armLocalPairing(CODE, 60_000, T0);
    expect((await redeemNonce(nonce)).ok).toBe(true);
    expect((await redeemNonce(nonce)).ok).toBe(false);
  });

  it("spends both halves at once — one offer, two spellings", async () => {
    // The property that stops a photograph of the QR outliving the digits
    // somebody has already typed.
    const { nonce } = armLocalPairing(CODE, 60_000, T0);
    expect((await redeemCode(CODE)).ok).toBe(true);
    expect((await redeemNonce(nonce)).ok).toBe(false);
  });

  it("rejects an expired offer", async () => {
    const { nonce } = armLocalPairing(CODE, 60_000, T0);
    expect((await redeemNonce(nonce, T0 + 60_001)).ok).toBe(false);
  });

  it("rejects a credential that was never armed", async () => {
    armLocalPairing(CODE, 60_000, T0);
    expect((await redeemNonce("not-the-nonce")).ok).toBe(false);
    expect((await redeemCode("000000")).ok).toBe(false);
  });

  it("keeps only the most recently armed offer live", async () => {
    const first = armLocalPairing("111111", 60_000, T0);
    const second = armLocalPairing("222222", 60_000, T0);
    expect((await redeemNonce(first.nonce)).ok).toBe(false);
    expect((await redeemCode("111111")).ok).toBe(false);
    expect((await redeemNonce(second.nonce)).ok).toBe(true);
  });

  it("issues distinct nonces", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) {
      seen.add(armLocalPairing(CODE, 60_000, T0).nonce);
    }
    expect(seen.size).toBe(50);
  });

  it("refuses to arm anything that is not digits", () => {
    expect(() => armLocalPairing("hunter2", 60_000, T0)).toThrow();
  });
});

/**
 * Six digits are guessable. Six digits with five tries are not — the budget is
 * the credential's security argument, not its length.
 */
describe("the guess budget", () => {
  beforeEach(resetPairingState);

  const CODE = "483921";

  it("burns the offer after five wrong codes", async () => {
    armLocalPairing(CODE, 60_000, T0);
    for (let i = 0; i < 4; i++) {
      expect((await redeemLocalPairing({ code: "000000" }, {}, T0)).ok).toBe(
        false,
      );
    }
    // Four wrong, and the real code still works.
    expect(hasLivePairingNonce(T0)).toBe(true);

    armLocalPairing(CODE, 60_000, T0);
    for (let i = 0; i < 5; i++) {
      await redeemLocalPairing({ code: "000000" }, {}, T0);
    }
    expect(hasLivePairingNonce(T0)).toBe(false);
    expect((await redeemLocalPairing({ code: CODE }, {}, T0)).ok).toBe(false);
  });

  it("tells the terminal the code is dead, so it can print a fresh one", async () => {
    const seen: string[] = [];
    onLocalPairingSpent((outcome) => seen.push(outcome));
    armLocalPairing(CODE, 60_000, T0);
    for (let i = 0; i < 5; i++) {
      await redeemLocalPairing({ code: "000000" }, {}, T0);
    }
    expect(seen).toEqual(["burned"]);
  });

  it("does not bill a stale nonce against the typed code's budget", async () => {
    // A reloaded tab re-posts a spent nonce. Charging that to the digits would
    // let a browser burn the code somebody is still reading off the screen.
    armLocalPairing(CODE, 60_000, T0);
    for (let i = 0; i < 20; i++) {
      await redeemLocalPairing({ nonce: "stale" }, {}, T0);
    }
    expect((await redeemLocalPairing({ code: CODE }, {}, T0)).ok).toBe(true);
  });
});

/**
 * Knowing the code is not consent. Every local admission raises the same
 * question every other path raises.
 */
describe("the approval gate", () => {
  beforeEach(resetPairingState);

  const CODE = "483921";

  it("asks before issuing a token, and names the device", async () => {
    const asked: unknown[] = [];
    setLocalPairingGate(async (req) => {
      asked.push(req);
      return true;
    });
    armLocalPairing(CODE, 60_000, T0);
    expect(
      (await redeemLocalPairing({ code: CODE }, { label: "iPhone" }, T0)).ok,
    ).toBe(true);
    expect(asked).toEqual([{ label: "iPhone", via: "code" }]);
  });

  it("reports which half was used", async () => {
    const asked: unknown[] = [];
    setLocalPairingGate(async (req) => {
      asked.push(req);
      return true;
    });
    const { nonce } = armLocalPairing(CODE, 60_000, T0);
    await redeemLocalPairing({ nonce }, { label: "iPad" }, T0);
    expect(asked).toEqual([{ label: "iPad", via: "scan" }]);
  });

  it("issues nothing when the machine says no", async () => {
    setLocalPairingGate(async () => false);
    armLocalPairing(CODE, 60_000, T0);
    expect(await redeemLocalPairing({ code: CODE }, {}, T0)).toEqual({
      ok: false,
      reason: "refused",
    });
  });

  it("spends the offer even when refused", async () => {
    // The ordering that matters: a correct code left live while the question
    // sits on screen is a code an attacker can retry the moment it is denied.
    setLocalPairingGate(async () => false);
    armLocalPairing(CODE, 60_000, T0);
    await redeemLocalPairing({ code: CODE }, {}, T0);
    setLocalPairingGate(async () => true);
    expect((await redeemLocalPairing({ code: CODE }, {}, T0)).ok).toBe(false);
  });

  it("treats a gate that throws as a refusal", async () => {
    setLocalPairingGate(async () => {
      throw new Error("the panel is gone");
    });
    armLocalPairing(CODE, 60_000, T0);
    expect(await redeemLocalPairing({ code: CODE }, {}, T0)).toEqual({
      ok: false,
      reason: "refused",
    });
  });

  it("admits when no gate is installed — split mode never arms an offer", async () => {
    armLocalPairing(CODE, 60_000, T0);
    expect((await redeemLocalPairing({ code: CODE }, {}, T0)).ok).toBe(true);
  });

  it("reports the outcome so the terminal can reprint", async () => {
    const seen: string[] = [];
    onLocalPairingSpent((outcome) => seen.push(outcome));
    setLocalPairingGate(async () => true);
    armLocalPairing(CODE, 60_000, T0);
    await redeemLocalPairing({ code: CODE }, {}, T0);
    setLocalPairingGate(async () => false);
    armLocalPairing(CODE, 60_000, T0);
    await redeemLocalPairing({ code: CODE }, {}, T0);
    expect(seen).toEqual(["paired", "refused"]);
  });
});

describe("session tokens", () => {
  beforeEach(resetPairingState);

  it("validates a token it issued", () => {
    const { token } = issueSessionToken(1000, T0);
    expect(isValidSessionToken(token, T0)).toBe(true);
  });

  it("rejects an unknown token", () => {
    issueSessionToken(1000, T0);
    expect(isValidSessionToken("f".repeat(64), T0)).toBe(false);
  });

  it("rejects a token left idle for its whole window", () => {
    const { token } = issueSessionToken(1000, T0);
    expect(isValidSessionToken(token, T0 + 1000)).toBe(false);
  });

  it("renews a token that is being used", () => {
    // The regression this pins: the window used to be a countdown from issue,
    // so a device in continuous use was cut off at exactly its token's age —
    // the "I have to restart the CLI every day" report. Each check here is
    // inside the window the one before it left behind.
    const { token } = issueSessionToken(1000, T0);
    expect(isValidSessionToken(token, T0 + 999)).toBe(true);
    expect(isValidSessionToken(token, T0 + 1998)).toBe(true);
    expect(isValidSessionToken(token, T0 + 2997)).toBe(true);
    // And it still goes cold once nothing is using it.
    expect(isValidSessionToken(token, T0 + 3997)).toBe(false);
  });

  it("renews a registered token on the lifetime it was registered with", () => {
    const token = "b".repeat(64);
    registerSessionToken(token, 5000, T0);
    expect(isValidSessionToken(token, T0 + 4999)).toBe(true);
    // Renewed by that check, so a moment past the *original* expiry is fine.
    expect(isValidSessionToken(token, T0 + 5001)).toBe(true);
    // That last check bought it until T0+10_001, and nothing used it since.
    expect(isValidSessionToken(token, T0 + 10_001)).toBe(false);
  });

  it("supports explicit revocation", () => {
    const { token } = issueSessionToken(10_000, T0);
    revokeSessionToken(token);
    expect(isValidSessionToken(token, T0)).toBe(false);
  });

  it("keeps multiple devices signed in independently", () => {
    const a = issueSessionToken(10_000, T0);
    const b = issueSessionToken(10_000, T0);
    revokeSessionToken(a.token);
    expect(isValidSessionToken(a.token, T0)).toBe(false);
    expect(isValidSessionToken(b.token, T0)).toBe(true);
  });

  it("lets an expired grant kill a token renewal would otherwise keep alive", () => {
    // Order matters inside `grantForToken`: renewal must never run ahead of
    // the grant check, or a share with an end date would be extended by the
    // very traffic it is supposed to stop carrying.
    const token = "a".repeat(64);
    registerSessionToken(token, 60_000, T0, {
      ...FULL_GRANT,
      expiresAt: T0 + 1_000,
    });
    expect(isValidSessionToken(token, T0 + 500)).toBe(true);
    expect(isValidSessionToken(token, T0 + 1_500)).toBe(false);
  });

  it("forgets everything on reset — a restart revokes all devices", () => {
    const { token } = issueSessionToken(10_000, T0);
    resetPairingState();
    expect(isValidSessionToken(token, T0)).toBe(false);
  });
});

describe("session token labels", () => {
  it("remembers what the CLI called the device", () => {
    const token = "c".repeat(64);
    registerSessionToken(
      token,
      60_000,
      Date.now(),
      FULL_GRANT,
      "iPhone · Safari",
    );
    expect(labelForToken(token)).toBe("iPhone · Safari");
  });

  it("has no label when none was supplied", () => {
    const token = "d".repeat(64);
    registerSessionToken(token, 60_000);
    expect(labelForToken(token)).toBeNull();
  });

  it("forgets the label once the token expires", () => {
    const token = "e".repeat(64);
    const now = Date.now();
    registerSessionToken(token, 1_000, now, FULL_GRANT, "Ghost");
    expect(labelForToken(token, now + 2_000)).toBeNull();
  });

  it("says nothing about a token it has never seen", () => {
    expect(labelForToken("f".repeat(64))).toBeNull();
  });
});

describe("telling the CLI a device is still in use", () => {
  beforeEach(resetPairingState);

  /*
   * The relay is the only side that sees a device authenticate. Without this
   * signal the CLI's peer store stayed pinned to the moment of pairing, so
   * `mtmux devices` expired a phone in daily use on schedule while the relay,
   * whose window had been sliding all along, kept letting it in.
   */
  it("names the device every time its token is used", () => {
    const token = "1".repeat(64);
    const seen: string[] = [];
    onSessionTokenUsed((id) => seen.push(id));
    registerSessionToken(token, 60_000, T0, FULL_GRANT, "iPhone", "dev-1");

    grantForToken(token, T0 + 1_000);
    grantForToken(token, T0 + 2_000);
    expect(seen).toEqual(["dev-1", "dev-1"]);
  });

  it("says nothing for a token with no peer record behind it", () => {
    // The LAN-QR path issues tokens that no `mtmux devices` entry names.
    const seen: string[] = [];
    onSessionTokenUsed((id) => seen.push(id));
    const { token } = issueSessionToken(60_000, T0);
    grantForToken(token, T0 + 1_000);
    expect(seen).toEqual([]);
  });

  it("says nothing when the token is refused", () => {
    const token = "2".repeat(64);
    const seen: string[] = [];
    onSessionTokenUsed((id) => seen.push(id));
    registerSessionToken(token, 1_000, T0, FULL_GRANT, "iPhone", "dev-2");
    expect(grantForToken(token, T0 + 2_000)).toBeNull();
    expect(seen).toEqual([]);
  });

  it("still admits the device when a listener throws", () => {
    // Bookkeeping must never be able to cost someone access.
    const token = "3".repeat(64);
    onSessionTokenUsed(() => {
      throw new Error("config file is read-only");
    });
    registerSessionToken(token, 60_000, T0, FULL_GRANT, "iPhone", "dev-3");
    expect(grantForToken(token, T0 + 1_000)).not.toBeNull();
  });

  it("stops reporting once unsubscribed", () => {
    const token = "4".repeat(64);
    const seen: string[] = [];
    onSessionTokenUsed((id) => seen.push(id))();
    registerSessionToken(token, 60_000, T0, FULL_GRANT, "iPhone", "dev-4");
    grantForToken(token, T0 + 1_000);
    expect(seen).toEqual([]);
  });

  it("does not report a lookup that only read a label", () => {
    // `labelForToken` is display-only and must stay outside every decision,
    // including this one — otherwise drawing the device line looks like use.
    const token = "5".repeat(64);
    const seen: string[] = [];
    onSessionTokenUsed((id) => seen.push(id));
    registerSessionToken(token, 60_000, T0, FULL_GRANT, "iPhone", "dev-5");
    labelForToken(token, T0 + 1_000);
    expect(seen).toEqual([]);
  });
});

/**
 * Revocation that does not disconnect is not revocation.
 *
 * Deleting the map entry only stops the *next* authentication; a socket that
 * authenticated a minute ago holds its grant in memory. These assert the
 * signal a live socket needs in order to be closed.
 */
describe("revocation reaches live sockets", () => {
  beforeEach(resetPairingState);

  const scoped = { ...FULL_GRANT, id: "share-1" };

  it("names the revoked token when a single token is dropped", () => {
    const token = "a".repeat(64);
    const events: { tokenIds: string[]; grantId: string | null }[] = [];
    onSessionTokenRevoked((e) => events.push(e));
    registerSessionToken(token, 60_000, T0, scoped, "iPhone", "dev-1");

    revokeSessionToken(token);
    expect(events).toEqual([
      { tokenIds: [sessionTokenId(token)], grantId: "share-1" },
    ]);
    expect(isValidSessionToken(token, T0 + 1_000)).toBe(false);
  });

  it("names every token of a grant when the grant is revoked", () => {
    const a = "b".repeat(64);
    const b = "c".repeat(64);
    const events: { tokenIds: string[] }[] = [];
    onSessionTokenRevoked((e) => events.push(e));
    registerSessionToken(a, 60_000, T0, scoped, "iPhone", "dev-1");
    registerSessionToken(b, 60_000, T0, scoped, "iPad", "dev-2");

    expect(revokeGrant("share-1")).toBe(2);
    expect(events).toHaveLength(1);
    expect(new Set(events[0]!.tokenIds)).toEqual(
      new Set([sessionTokenId(a), sessionTokenId(b)]),
    );
  });

  it("says nothing when the token was never registered", () => {
    const events: unknown[] = [];
    onSessionTokenRevoked((e) => events.push(e));
    revokeSessionToken("d".repeat(64));
    expect(revokeGrant("nobody")).toBe(0);
    expect(events).toEqual([]);
  });

  it("still revokes when a listener throws", () => {
    const token = "e".repeat(64);
    onSessionTokenRevoked(() => {
      throw new Error("socket already gone");
    });
    registerSessionToken(token, 60_000, T0, scoped, "iPhone", "dev-1");
    revokeSessionToken(token);
    expect(isValidSessionToken(token, T0 + 1_000)).toBe(false);
  });
});

/**
 * Taking the offer down without spending it.
 *
 * The case is a server that started local-only and then opened a tunnel: its
 * banner is replaced, so the six digits stop being on screen, and an offer
 * armed for a day would go on being claimable with nothing displaying it.
 */
describe("disarming a local offer", () => {
  it("stops the code working", async () => {
    armLocalPairing("123456");
    disarmLocalPairing();
    await expect(redeemLocalPairing({ code: "123456" })).resolves.toEqual({
      ok: false,
      reason: "invalid",
    });
  });

  it("stops the QR's nonce working too", async () => {
    const { nonce } = armLocalPairing("123456");
    disarmLocalPairing();
    await expect(redeemLocalPairing({ nonce })).resolves.toEqual({
      ok: false,
      reason: "invalid",
    });
  });

  it("is not a spend, so nothing re-arms behind it", () => {
    const seen: string[] = [];
    onLocalPairingSpent((o) => seen.push(o));
    armLocalPairing("123456");
    disarmLocalPairing();
    // A spend is what tells the CLI to print a fresh code. Disarming is the
    // opposite instruction, and firing it here would put a dead code back on
    // a banner that has just been replaced.
    expect(seen).toEqual([]);
  });

  it("says nothing when there was nothing armed", () => {
    expect(() => disarmLocalPairing()).not.toThrow();
  });
});
