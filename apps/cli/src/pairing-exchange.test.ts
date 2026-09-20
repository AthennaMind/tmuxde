import { describe, it, expect } from "vitest";
import {
  cpaceStart,
  deriveSessionKeys,
  confirmationTag,
  transcriptIr,
  bytesToHex,
  hexToBytes,
  utf8ToBytes,
  randomBytes,
} from "@repo/crypto";
import type { PairPeerShareMessage, SealedDescriptor } from "@repo/protocol";
import {
  AD_CLI,
  PairingError,
  runExchange,
  type Derived,
  type ExchangeSide,
  type PairingSocket,
} from "./pairing-exchange.js";

/**
 * The exchange engine on its own, driven from the mailbox side.
 *
 * `pairing-client.test.ts` covers both flows through their real entry points;
 * what this file adds is the case those cannot reach — a mailbox holder facing
 * several candidate peers at once. The broker offers a mailbox to one claim at
 * a time, so that shape only arises when an offer lapses and a second claim
 * arrives, and the fan-out path would otherwise go untested in this direction.
 */

const DESCRIPTOR: SealedDescriptor = {
  candidates: [],
  tunnelId: "tnl-abcdefgh",
  deviceId: "0".repeat(16),
  publicKey: "1".repeat(64),
  label: "gagan@thinkpad",
};

const SLOT = "49";

function fakeSocket() {
  const sent: Record<string, unknown>[] = [];
  let inbound: ((raw: string) => void) | null = null;
  let onClose: (() => void) | null = null;

  const socket: PairingSocket = {
    send: (m) => sent.push(m as Record<string, unknown>),
    onMessage: (cb) => {
      inbound = cb;
    },
    onClose: (cb) => {
      onClose = cb;
    },
    close: () => {},
  };

  return {
    socket,
    sent,
    deliver: (msg: unknown) => inbound?.(JSON.stringify(msg)),
    drop: () => onClose?.(),
    find: (type: string, peer: string) =>
      sent.find((m) => m.type === type && m.peer === peer) as
        | Record<string, string>
        | undefined,
  };
}

/** The CLI's mailbox-side key derivation, as `hostPairing` performs it. */
function mailboxDerive(secret: string) {
  return (msg: PairPeerShareMessage): Derived => {
    const cpace = cpaceStart(
      utf8ToBytes(secret),
      utf8ToBytes(SLOT),
      hexToBytes(msg.sid),
    );
    const peerShare = hexToBytes(msg.share);
    let isk: Uint8Array;
    try {
      isk = cpace.finish(peerShare, {
        own: utf8ToBytes(AD_CLI),
        peer: utf8ToBytes(msg.ad),
        isInitiator: false,
      });
    } catch {
      return { reject: "invalid share" };
    }
    return {
      attempt: {
        peer: msg.peer,
        ownShare: cpace.share,
        peerAd: msg.ad,
        keys: deriveSessionKeys(
          isk,
          transcriptIr(
            peerShare,
            utf8ToBytes(msg.ad),
            cpace.share,
            utf8ToBytes(AD_CLI),
          ),
        ),
      },
    };
  };
}

function run(opts: {
  secret: string;
  side?: ExchangeSide;
  maxPeers?: number;
  noMatchGraceMs?: number;
  admit?: (peerLabel: string) => Promise<boolean>;
}) {
  const io = fakeSocket();
  const exchange = runExchange({
    socket: io.socket,
    side: opts.side ?? "mailbox",
    maxPeers: opts.maxPeers,
    // Matches `hostPairing`: on the mailbox side a ruled-out peer has already
    // had its mailbox destroyed, so there is no straggler to wait for.
    noMatchGraceMs: opts.noMatchGraceMs ?? 0,
    derive: mailboxDerive(opts.secret),
    ...(opts.admit ? { admit: opts.admit } : {}),
    buildDescriptor: () => DESCRIPTOR,
    seal: () => Promise.resolve(new Uint8Array([1, 2, 3])),
    timeoutMs: 2_000,
    errors: {
      noMatch: () => new PairingError("did not match"),
      timedOut: () => new PairingError("timed out"),
      lost: () => new PairingError("lost"),
      tooManyPeers: () => new PairingError("too many peers"),
      failed: (reason) => new PairingError(`failed: ${reason}`),
    },
  });
  return { ...io, exchange };
}

/** One browser claiming the slot, as the CPace initiator. */
function claimAs(
  io: ReturnType<typeof fakeSocket>,
  peer: string,
  secret: string,
) {
  const sid = randomBytes(16);
  const browser = cpaceStart(utf8ToBytes(secret), utf8ToBytes(SLOT), sid);
  io.deliver({
    type: "pair:peer-share",
    peer,
    share: bytesToHex(browser.share),
    ad: "browser",
    sid: bytesToHex(sid),
  });

  const share = io.find("pair:share", peer)!;
  const isk = browser.finish(hexToBytes(share.share!), {
    own: utf8ToBytes("browser"),
    peer: utf8ToBytes(share.ad!),
    isInitiator: true,
  });
  const keys = deriveSessionKeys(
    isk,
    transcriptIr(
      browser.share,
      utf8ToBytes("browser"),
      hexToBytes(share.share!),
      utf8ToBytes(share.ad!),
    ),
  );
  return {
    keys,
    confirm: () =>
      io.deliver({
        type: "pair:peer-confirm",
        peer,
        tag: bytesToHex(confirmationTag(keys.confirm, "browser")),
      }),
  };
}

describe("mailbox-side fan-out", () => {
  it("keeps the peer whose confirmation verifies and closes the rest", async () => {
    const secret = "2716";
    const io = run({ secret });

    const decoy = claimAs(io, "peer-0", "0000");
    const real = claimAs(io, "peer-1", secret);
    decoy.confirm();
    real.confirm();

    const result = await io.exchange.result;
    expect(bytesToHex(result.keys.c2s)).toBe(bytesToHex(real.keys.c2s));
    expect(io.find("pair:close", "peer-0")).toBeDefined();
    expect(io.find("pair:close", "peer-1")).toBeUndefined();
    expect(io.find("pair:establish", "peer-1")).toBeDefined();
  });

  /**
   * The gate sits before `pair:establish`, and that placement is the whole
   * point of it.
   *
   * A browser that has been handed the descriptor has already won: it races
   * the direct candidates, opens a socket and authenticates, and `ws-client`
   * treats `auth:failure` as a permanent close. So a refusal that arrives
   * after establishment is not a refusal, it is a broken pairing. These two
   * assert the descriptor never leaves on a no, and does on a yes.
   */
  it("seals nothing for a peer the machine refused", async () => {
    const secret = "2716";
    const seen: string[] = [];
    const io = run({
      secret,
      admit: async (label) => {
        seen.push(label);
        return false;
      },
    });

    claimAs(io, "peer-0", secret).confirm();

    await expect(io.exchange.result).rejects.toThrow("did not match");
    expect(seen).toEqual(["browser"]);
    expect(io.find("pair:establish", "peer-0")).toBeUndefined();
    expect(io.find("pair:close", "peer-0")).toMatchObject({
      reason: "refused at the machine",
    });
  });

  it("establishes once the machine says yes", async () => {
    const secret = "2716";
    const io = run({ secret, admit: async () => true });
    const real = claimAs(io, "peer-0", secret);
    real.confirm();

    const result = await io.exchange.result;
    expect(bytesToHex(result.keys.c2s)).toBe(bytesToHex(real.keys.c2s));
    expect(io.find("pair:establish", "peer-0")).toBeDefined();
  });

  it("answers every peer with its own share and tag before any of them prove anything", () => {
    const io = run({ secret: "2716" });
    claimAs(io, "peer-0", "0000");
    claimAs(io, "peer-1", "2716");
    for (const peer of ["peer-0", "peer-1"]) {
      expect(io.find("pair:share", peer)?.ad).toBe(AD_CLI);
      expect(io.find("pair:confirm", peer)).toBeDefined();
    }
  });

  it("fails once every candidate has been ruled out", async () => {
    const io = run({ secret: "2716" });
    claimAs(io, "peer-0", "0000").confirm();
    claimAs(io, "peer-1", "9999").confirm();
    await expect(io.exchange.result).rejects.toThrow(/did not match/);
  });

  it("retires one peer on a peer-scoped failure and keeps waiting", async () => {
    const secret = "2716";
    const io = run({ secret });

    io.deliver({ type: "pair:failed", peer: "peer-0", reason: "peer-gone" });
    const real = claimAs(io, "peer-1", secret);
    real.confirm();

    const result = await io.exchange.result;
    expect(bytesToHex(result.keys.c2s)).toBe(bytesToHex(real.keys.c2s));
  });

  it("ends the run on a failure that names no peer", async () => {
    const io = run({ secret: "2716" });
    io.deliver({ type: "pair:failed", reason: "expired" });
    await expect(io.exchange.result).rejects.toThrow(/failed: expired/);
  });

  it("ignores pair:ready, which is an acknowledgement and not news", async () => {
    const secret = "2716";
    const io = run({ secret });
    io.deliver({
      type: "pair:ready",
      mailboxId: "mbx-abcdefgh",
      slot: SLOT,
      expiresAt: Date.now() + 60_000,
    });
    claimAs(io, "peer-0", secret).confirm();
    await expect(io.exchange.result).resolves.toBeDefined();
  });

  it("surfaces a dropped socket", async () => {
    const io = run({ secret: "2716" });
    io.drop();
    await expect(io.exchange.result).rejects.toThrow(/lost/);
  });

  it("abort settles the run and nothing later can unsettle it", async () => {
    const secret = "2716";
    const io = run({ secret });
    io.exchange.abort(new PairingError("cancelled"));
    claimAs(io, "peer-0", secret).confirm();
    await expect(io.exchange.result).rejects.toThrow(/cancelled/);
  });
});
