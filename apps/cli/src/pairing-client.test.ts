import { describe, it, expect } from "vitest";
import {
  cpaceStart,
  deriveSessionKeys,
  confirmationTag,
  verifyConfirmation,
  transcriptIr,
  bytesToHex,
  hexToBytes,
  utf8ToBytes,
  randomBytes,
  generateLongSecret,
  parseCode,
  type SessionKeys,
} from "@repo/crypto";
import { MAX_PEERS_PER_SLOT, type SealedDescriptor } from "@repo/protocol";
import {
  pairWithCode,
  hostPairing,
  PairingError,
  type ClaimTransport,
  type MailboxTransport,
  type PairingSocket,
} from "./pairing-client.js";

const DESCRIPTOR: SealedDescriptor = {
  candidates: ["http://192.168.1.5:14100"],
  tunnelId: "tnl-abcdefgh",
  deviceId: "0".repeat(16),
  publicKey: "1".repeat(64),
  label: "gagan@thinkpad",
};

/**
 * A stand-in broker plus one or more scripted browsers, each running real
 * CPace. The point is to exercise fan-out: the CLI must survive answering
 * several mailboxes and keep only the one whose confirmation verifies.
 */
function scenario(opts: {
  /** One entry per mailbox that answers, with the secret it believes in. */
  browserSecrets: string[];
  /** Mailboxes that are offered the claim but never answer. */
  silent?: number;
}) {
  const sent: Record<string, unknown>[] = [];
  let inbound: ((raw: string) => void) | null = null;
  let onClose: (() => void) | null = null;
  const closedPeers: string[] = [];
  // Resolves once pairWithCode has posted its claim and wired up the socket,
  // so scripted browsers cannot fire into a listener that does not exist yet.
  let markReady!: () => void;
  const ready = new Promise<void>((resolve) => {
    markReady = resolve;
  });

  let slot = "";
  let cliShare = "";
  let cliAd = "";
  let sid = "";

  const socket: PairingSocket = {
    send(message) {
      const msg = message as Record<string, unknown>;
      sent.push(msg);
      if (msg.type === "pair:close" && typeof msg.peer === "string") {
        closedPeers.push(msg.peer);
      }
    },
    onMessage(cb) {
      inbound = cb;
      markReady();
    },
    onClose(cb) {
      onClose = cb;
    },
    close() {},
  };

  const transport: ClaimTransport = {
    postClaim(body) {
      const b = body as {
        slot: string;
        share: string;
        ad: string;
        sid: string;
      };
      slot = b.slot;
      cliShare = b.share;
      cliAd = b.ad;
      sid = b.sid;
      // A claim id and a deadline, and nothing about the slot: since 0.7.0 the
      // POST does not look at it. "Nothing was waiting" arrives on the socket,
      // which is why `openClaimSocket` below has to say it.
      return Promise.resolve({ claimId: "clm-abcdefgh" });
    },
    openClaimSocket() {
      // The broker fans a claim out when its socket attaches, and answers
      // `peer-gone` there when the slot held nothing. Scripted here because it
      // is the only way a claimant learns that now.
      if (opts.browserSecrets.length + (opts.silent ?? 0) === 0) {
        void ready.then(() =>
          deliver({ type: "pair:failed", reason: "peer-gone" }),
        );
      }
      return Promise.resolve(socket);
    },
  };

  function deliver(msg: unknown) {
    inbound?.(JSON.stringify(msg));
  }

  /**
   * Run one browser's half of the exchange and push its messages at the CLI.
   *
   * `confirmNow: false` sends only the share, so a test can line several peers
   * up before any of them is ruled out — the CLI treats "everyone answered and
   * everyone was wrong" differently from "the only answer so far was wrong".
   */
  function runBrowser(index: number, confirmNow = true) {
    const secret = opts.browserSecrets[index]!;
    const peer = `peer-${index}`;
    const browser = cpaceStart(
      utf8ToBytes(secret),
      utf8ToBytes(slot),
      hexToBytes(sid),
    );
    const ad = "browser";
    const isk = browser.finish(hexToBytes(cliShare), {
      own: utf8ToBytes(ad),
      peer: utf8ToBytes(cliAd),
      isInitiator: false,
    });
    const keys = deriveSessionKeys(
      isk,
      transcriptIr(
        hexToBytes(cliShare),
        utf8ToBytes(cliAd),
        browser.share,
        utf8ToBytes(ad),
      ),
    );

    deliver({
      type: "pair:peer-share",
      peer,
      share: bytesToHex(browser.share),
      ad,
      sid,
    });
    const confirm = () =>
      deliver({
        type: "pair:peer-confirm",
        peer,
        tag: bytesToHex(confirmationTag(keys.confirm, "browser")),
      });
    if (confirmNow) confirm();
    return { peer, keys, confirm };
  }

  return {
    transport,
    sent,
    closedPeers,
    deliver,
    runBrowser,
    ready,
    get slot() {
      return slot;
    },
    dropConnection: () => onClose?.(),
  };
}

const sealed: (
  keys: SessionKeys,
  d: SealedDescriptor,
) => Promise<Uint8Array> = () => Promise.resolve(new Uint8Array([1, 2, 3]));

describe("code validation", () => {
  const transport: ClaimTransport = {
    postClaim: () => Promise.reject(new Error("should not be called")),
    openClaimSocket: () => Promise.reject(new Error("should not be called")),
  };

  it("refuses a code of any other length before contacting the broker", async () => {
    for (const code of ["12345", "12345678", "1234567890", "12 34 5"]) {
      await expect(
        pairWithCode({
          code,
          transport,
          buildDescriptor: () => DESCRIPTOR,
          seal: sealed,
        }),
        // The wrong-length message names what we accept rather than asserting
        // one length, so the next change of length does not make it a lie.
      ).rejects.toThrow(/pairing codes are 9/);
    }
  });

  it("says something different when it is not digits at all", async () => {
    for (const code of ["", "abcdef", "hello there", "492-71!6-384"]) {
      await expect(
        pairWithCode({
          code,
          transport,
          buildDescriptor: () => DESCRIPTOR,
          seal: sealed,
        }),
      ).rejects.toThrow(/doesn't look like a pairing code/);
    }
  });

  it("accepts spaced and dashed codes", async () => {
    const s = scenario({ browserSecrets: [] });
    // Nothing waiting short-circuits, which is enough to prove the code parsed.
    await expect(
      pairWithCode({
        code: "492 71-6384",
        transport: s.transport,
        buildDescriptor: () => DESCRIPTOR,
        seal: sealed,
      }),
    ).rejects.toThrow(/stopped waiting for this code/);
    expect(s.slot).toBe("492");
  });
});

describe("successful pairing", () => {
  it("derives the browser's key and hands over the sealed descriptor", async () => {
    const secret = "716384";
    const s = scenario({ browserSecrets: [secret] });

    const promise = pairWithCode({
      code: `492${secret}`,
      transport: s.transport,
      buildDescriptor: () => DESCRIPTOR,
      seal: sealed,
    });

    await s.ready;
    const browser = s.runBrowser(0);
    const result = await promise;

    expect(bytesToHex(result.keys.c2s)).toBe(bytesToHex(browser.keys.c2s));
    expect(result.keys.directToken).toBe(browser.keys.directToken);

    const confirm = s.sent.find((m) => m.type === "pair:confirm");
    expect(confirm?.peer).toBe(browser.peer);
    const establish = s.sent.find((m) => m.type === "pair:establish");
    expect(establish?.sealedDescriptor).toBe("AQID");
  });

  it("never puts the secret on the wire", async () => {
    const secret = "716384";
    const s = scenario({ browserSecrets: [secret] });
    const promise = pairWithCode({
      code: `492${secret}`,
      transport: s.transport,
      buildDescriptor: () => DESCRIPTOR,
      seal: sealed,
    });
    await s.ready;
    s.runBrowser(0);
    await promise;
    expect(JSON.stringify(s.sent)).not.toContain(secret);
  });
});

describe("fan-out", () => {
  it("ignores mailboxes whose secret does not match and keeps the one that does", async () => {
    const secret = "716384";
    // A decoy sharing the slot, then the real one. Two is the broker's cap.
    const s = scenario({ browserSecrets: ["000000", secret] });

    const promise = pairWithCode({
      code: `492${secret}`,
      transport: s.transport,
      buildDescriptor: () => DESCRIPTOR,
      seal: sealed,
    });

    await s.ready;
    s.runBrowser(0);
    const real = s.runBrowser(1);
    const result = await promise;

    expect(bytesToHex(result.keys.c2s)).toBe(bytesToHex(real.keys.c2s));
    // The decoy was closed, which destroys its mailbox.
    expect(s.closedPeers).toEqual(["peer-0"]);
  });

  it("refuses a broker offering more peers than a slot may hold", async () => {
    // More answers than the cap is the signature of a broker fanning one claim
    // out to attackers to multiply their guesses. Racing them would be doing
    // exactly what the cap exists to prevent.
    const secrets = Array.from(
      { length: MAX_PEERS_PER_SLOT + 1 },
      () => "000000",
    );
    const s = scenario({ browserSecrets: secrets });

    const promise = pairWithCode({
      code: "492716384",
      transport: s.transport,
      buildDescriptor: () => DESCRIPTOR,
      seal: sealed,
    });

    await s.ready;
    // Shares only: the run must refuse on the count alone, before any of them
    // is ruled out on its tag.
    for (let i = 0; i < secrets.length; i += 1) s.runBrowser(i, false);

    await expect(promise).rejects.toThrow(/more terminals than it should/);
  });

  it("fails once every offered mailbox has been ruled out", async () => {
    const s = scenario({ browserSecrets: ["000000", "999999"] });
    const promise = pairWithCode({
      code: "492716384",
      transport: s.transport,
      buildDescriptor: () => DESCRIPTOR,
      seal: sealed,
    });
    await s.ready;
    s.runBrowser(0);
    s.runBrowser(1);
    await expect(promise).rejects.toThrow(/did not match/);
  });
});

describe("failure handling", () => {
  it("reports a code nobody is waiting for, once its socket attaches", async () => {
    const s = scenario({ browserSecrets: [] });
    await expect(
      pairWithCode({
        code: "492716384",
        transport: s.transport,
        buildDescriptor: () => DESCRIPTOR,
        seal: sealed,
      }),
    ).rejects.toThrow(/stopped waiting for this code/);
  });

  it("times out rather than hanging", async () => {
    const s = scenario({ browserSecrets: [], silent: 1 });
    await expect(
      pairWithCode({
        code: "492716384",
        transport: s.transport,
        buildDescriptor: () => DESCRIPTOR,
        seal: sealed,
        timeoutMs: 20,
      }),
    ).rejects.toThrow(/timed out/i);
  });

  it("surfaces a lost broker connection", async () => {
    const s = scenario({ browserSecrets: [], silent: 1 });
    const promise = pairWithCode({
      code: "492716384",
      transport: s.transport,
      buildDescriptor: () => DESCRIPTOR,
      seal: sealed,
    });
    await s.ready;
    s.dropConnection();
    await expect(promise).rejects.toThrow(/Lost the connection/);
  });

  it("translates broker failure reasons into something actionable", async () => {
    const s = scenario({ browserSecrets: [], silent: 1 });
    const promise = pairWithCode({
      code: "492716384",
      transport: s.transport,
      buildDescriptor: () => DESCRIPTOR,
      seal: sealed,
    });
    await s.ready;
    s.deliver({ type: "pair:failed", reason: "expired" });
    await expect(promise).rejects.toThrow(/expired/);
  });

  it("rejects a share that is not a valid group element", async () => {
    const s = scenario({ browserSecrets: [], silent: 1 });
    const promise = pairWithCode({
      code: "492716384",
      transport: s.transport,
      buildDescriptor: () => DESCRIPTOR,
      seal: sealed,
    });
    await s.ready;
    s.deliver({
      type: "pair:peer-share",
      peer: "peer-evil",
      share: "f".repeat(64),
      ad: "browser",
      sid: bytesToHex(randomBytes(16)),
    });
    await expect(promise).rejects.toThrow(/did not match/);
    expect(s.closedPeers).toContain("peer-evil");
  });

  it("carries a hint alongside the message", async () => {
    const s = scenario({ browserSecrets: [] });
    const err = await pairWithCode({
      code: "492716384",
      transport: s.transport,
      buildDescriptor: () => DESCRIPTOR,
      seal: sealed,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PairingError);
    expect((err as PairingError).hint).toMatch(/one attempt/);
  });
});

/**
 * The inverted direction: the CLI parks the mailbox (`mtmux start`) and a
 * scripted browser claims the code. Every browser step here is the real CPace
 * exchange, so a transcript ordered the wrong way round fails these tests
 * rather than quietly deriving two different keys from one correct code.
 */
function hostScenario(opts: { slot?: string; expiresInMs?: number } = {}) {
  const slot = opts.slot ?? "492";
  const sent: Record<string, unknown>[] = [];
  const closedPeers: string[] = [];
  let inbound: ((raw: string) => void) | null = null;
  let markReady!: () => void;
  const ready = new Promise<void>((resolve) => {
    markReady = resolve;
  });

  const socket: PairingSocket = {
    send(message) {
      const msg = message as Record<string, unknown>;
      sent.push(msg);
      if (msg.type === "pair:close" && typeof msg.peer === "string") {
        closedPeers.push(msg.peer);
      }
    },
    onMessage(cb) {
      inbound = cb;
      markReady();
    },
    onClose() {},
    close() {},
  };

  const requestedSpaces: (string | undefined)[] = [];
  const transport: MailboxTransport = {
    postMailbox: (space) => {
      requestedSpaces.push(space);
      return Promise.resolve({
        mailboxId: "mbx-abcdefgh",
        slot,
        expiresAt: Date.now() + (opts.expiresInMs ?? 180_000),
      });
    },
    openMailboxSocket: () => Promise.resolve(socket),
  };

  function deliver(msg: unknown) {
    inbound?.(JSON.stringify(msg));
  }

  function find(type: string, peer: string) {
    return sent.find((m) => m.type === type && m.peer === peer) as
      | Record<string, string>
      | undefined;
  }

  /** One browser claiming the code, as the CPace initiator. */
  function claim(peer: string, secret: string) {
    const sid = randomBytes(16);
    const browser = cpaceStart(utf8ToBytes(secret), utf8ToBytes(slot), sid);
    const ad = "browser";

    deliver({
      type: "pair:peer-share",
      peer,
      share: bytesToHex(browser.share),
      ad,
      sid: bytesToHex(sid),
    });

    // The CLI answers with its own share and its confirmation tag, in that
    // order, before the browser has proved anything.
    const share = find("pair:share", peer)!;
    const isk = browser.finish(hexToBytes(share.share!), {
      own: utf8ToBytes(ad),
      peer: utf8ToBytes(share.ad!),
      isInitiator: true,
    });
    const keys = deriveSessionKeys(
      isk,
      transcriptIr(
        browser.share,
        utf8ToBytes(ad),
        hexToBytes(share.share!),
        utf8ToBytes(share.ad!),
      ),
    );

    const cliConfirm = find("pair:confirm", peer);
    const cliTagVerifies =
      cliConfirm !== undefined &&
      verifyConfirmation(keys.confirm, "cli", hexToBytes(cliConfirm.tag!));

    return {
      keys,
      cliTagVerifies,
      /** Answer honestly with the tag this browser derived. */
      confirm: () =>
        deliver({
          type: "pair:peer-confirm",
          peer,
          tag: bytesToHex(confirmationTag(keys.confirm, "browser")),
        }),
      confirmWith: (tag: string) =>
        deliver({ type: "pair:peer-confirm", peer, tag }),
    };
  }

  return {
    transport,
    sent,
    closedPeers,
    ready,
    deliver,
    claim,
    slot,
    requestedSpaces,
  };
}

const hostOpts = (transport: MailboxTransport) => ({
  transport,
  buildDescriptor: () => DESCRIPTOR,
  seal: sealed,
});

describe("hostPairing", () => {
  it("shows nine digits: the broker's slot plus a locally generated secret", async () => {
    const s = hostScenario({ slot: "007" });
    const hosted = await hostPairing(hostOpts(s.transport));
    expect(hosted.code).toMatch(/^\d{9}$/);
    expect(hosted.slot).toBe("007");
    expect(hosted.code.slice(0, 3)).toBe("007");
    expect(hosted.expiresAt).toBeGreaterThan(Date.now());
    hosted.cancel();
  });

  it("takes the slot the broker gave it, whatever its width", async () => {
    // The CLI takes the slot width from the broker rather than assuming one,
    // which is what lets the scan space be four digits wide while the typed
    // space is three — and what let the typed space widen at all.
    const s = hostScenario({ slot: "0731" });
    const hosted = await hostPairing({
      ...hostOpts(s.transport),
      space: "scan",
      secret: generateLongSecret(),
    });
    expect(hosted.slot).toBe("0731");
    expect(hosted.code.slice(0, 4)).toBe("0731");
    expect(parseCode(hosted.code)).toEqual({
      slot: "0731",
      secret: hosted.code.slice(4),
    });
    hosted.cancel();
  });

  it("asks for the space its secret belongs to", async () => {
    const s = hostScenario();
    const hosted = await hostPairing({
      ...hostOpts(s.transport),
      space: "scan",
      secret: generateLongSecret(),
    });
    expect(s.requestedSpaces).toEqual(["scan"]);
    hosted.cancel();
  });

  /**
   * The gate on a hosted code, which for a while was declared at one end and
   * unwired at the other.
   *
   * `ExchangeOptions.admit` existed, was documented and was honoured by
   * `pairing-exchange.ts`. `HostOptions` never declared it and `hostPairing`
   * never forwarded it, so `mtmux start` set `admit: confirmCodePairing` on an
   * object that dropped it on the floor — and a spread into a call site takes
   * no excess-property check, so the compiler had nothing to say. Every hosted
   * pairing completed without a soul being asked: knowing the code *was* the
   * approval, which is the exact belief the gate was written to end.
   *
   * These two tests are the wiring, asserted from the outside. They fail
   * against a `hostPairing` that forgets to pass it on.
   */
  it("asks at the machine before it seals anything for the browser", async () => {
    const asked: string[] = [];
    const s = hostScenario();
    const hosted = await hostPairing({
      ...hostOpts(s.transport),
      admit: async (label) => {
        asked.push(label);
        return true;
      },
    });
    await s.ready;

    const browser = s.claim("peer-0", hosted.code.slice(3));
    browser.confirm();
    await hosted.paired;

    expect(asked).toEqual(["browser"]);
  });

  it("seals nothing when the answer is no", async () => {
    const s = hostScenario();
    const hosted = await hostPairing({
      ...hostOpts(s.transport),
      admit: async () => false,
    });
    await s.ready;

    const browser = s.claim("peer-0", hosted.code.slice(3));
    browser.confirm();
    await expect(hosted.paired).rejects.toThrow();

    // The descriptor is the only thing that tells a browser where this machine
    // is. A refusal that still sent it would be a refusal in name only.
    expect(s.sent.find((m) => m.type === "pair:establish")).toBeUndefined();
    expect(s.closedPeers).toContain("peer-0");
  });

  it("agrees on a key with a browser that claims the code", async () => {
    const s = hostScenario();
    const hosted = await hostPairing(hostOpts(s.transport));
    await s.ready;

    const browser = s.claim("peer-0", hosted.code.slice(3));
    expect(browser.cliTagVerifies).toBe(true);
    browser.confirm();

    const result = await hosted.paired;
    expect(bytesToHex(result.keys.c2s)).toBe(bytesToHex(browser.keys.c2s));
    expect(bytesToHex(result.keys.s2c)).toBe(bytesToHex(browser.keys.s2c));
    expect(result.keys.directToken).toBe(browser.keys.directToken);

    const establish = s.sent.find((m) => m.type === "pair:establish");
    expect(establish?.peer).toBe("peer-0");
    expect(establish?.sealedDescriptor).toBe("AQID");
  });

  it("never puts the secret on the wire", async () => {
    const s = hostScenario();
    const hosted = await hostPairing(hostOpts(s.transport));
    await s.ready;
    const secret = hosted.code.slice(3);
    s.claim("peer-0", secret).confirm();
    await hosted.paired;
    expect(JSON.stringify(s.sent)).not.toContain(secret);
  });

  it("burns the code when the browser guessed wrong", async () => {
    const s = hostScenario();
    const hosted = await hostPairing(hostOpts(s.transport));
    await s.ready;

    // Any secret but the real one. The CLI's tag cannot verify for the browser
    // and the browser's tag cannot verify for the CLI.
    const real = hosted.code.slice(3);
    const wrong = real === "0000" ? "0001" : "0000";
    const browser = s.claim("peer-0", wrong);
    expect(browser.cliTagVerifies).toBe(false);
    browser.confirm();

    await expect(hosted.paired).rejects.toThrow(/did not match/);
    // Closing the peer is what destroys the mailbox, so the code is spent.
    expect(s.closedPeers).toEqual(["peer-0"]);
    expect(s.sent.some((m) => m.type === "pair:establish")).toBe(false);
  });

  it("rejects a tampered confirmation tag", async () => {
    const s = hostScenario();
    const hosted = await hostPairing(hostOpts(s.transport));
    await s.ready;

    const browser = s.claim("peer-0", hosted.code.slice(3));
    const good = bytesToHex(confirmationTag(browser.keys.confirm, "browser"));
    // One flipped nibble — the key is right, the tag is not.
    browser.confirmWith((good[0] === "0" ? "1" : "0") + good.slice(1));

    await expect(hosted.paired).rejects.toThrow(/did not match/);
    expect(s.closedPeers).toEqual(["peer-0"]);
  });

  it("refuses a share that is not a valid group element", async () => {
    const s = hostScenario();
    const hosted = await hostPairing(hostOpts(s.transport));
    await s.ready;
    s.deliver({
      type: "pair:peer-share",
      peer: "peer-evil",
      share: "f".repeat(64),
      ad: "browser",
      sid: bytesToHex(randomBytes(16)),
    });
    await expect(hosted.paired).rejects.toThrow(/did not match/);
    expect(s.closedPeers).toContain("peer-evil");
  });

  it("ignores a second share for a conversation already under way", async () => {
    const s = hostScenario();
    const hosted = await hostPairing(hostOpts(s.transport));
    await s.ready;

    const browser = s.claim("peer-0", hosted.code.slice(3));
    // A second share for the same peer must not restart the run or replace the
    // key the first one established.
    s.deliver({
      type: "pair:peer-share",
      peer: "peer-0",
      share: "f".repeat(64),
      ad: "browser",
      sid: bytesToHex(randomBytes(16)),
    });
    expect(s.closedPeers).toEqual([]);

    browser.confirm();
    const result = await hosted.paired;
    expect(bytesToHex(result.keys.c2s)).toBe(bytesToHex(browser.keys.c2s));
  });

  it("gives up when the code expires unused", async () => {
    const s = hostScenario({ expiresInMs: 20 });
    // Explicit, because the deadline derived from `expiresAt` is now clamped to
    // a 30s floor — a broker that says a code has already expired is far more
    // likely to be a skewed clock than a real 20ms code.
    const hosted = await hostPairing({
      ...hostOpts(s.transport),
      timeoutMs: 20,
    });
    await expect(hosted.paired).rejects.toThrow(/expired/);
  });

  it("cancel destroys the mailbox rather than leaving a dead code claimable", async () => {
    const s = hostScenario();
    const hosted = await hostPairing(hostOpts(s.transport));
    await s.ready;
    hosted.cancel();
    hosted.cancel(); // idempotent

    expect(s.sent).toContainEqual({ type: "pair:close", reason: "cancelled" });
    expect(s.sent.filter((m) => m.type === "pair:close")).toHaveLength(1);
    await expect(hosted.paired).rejects.toThrow(/cancelled/i);
  });

  it("re-arms with a fresh secret and pairs on the new code", async () => {
    const opts = { buildDescriptor: () => DESCRIPTOR, seal: sealed };

    const first = hostScenario();
    const spent = await hostPairing({ ...opts, transport: first.transport });
    await first.ready;
    spent.cancel();
    await expect(spent.paired).rejects.toThrow();

    // Re-arming is just calling again: nothing survives from the spent code.
    const second = hostScenario();
    const fresh = await hostPairing({ ...opts, transport: second.transport });
    await second.ready;
    const browser = second.claim("peer-0", fresh.code.slice(3));
    browser.confirm();

    const result = await fresh.paired;
    expect(bytesToHex(result.keys.c2s)).toBe(bytesToHex(browser.keys.c2s));
    // The old code's secret is worthless against the new mailbox.
    expect(second.sent.some((m) => m.type === "pair:establish")).toBe(true);
  });

  it("needs somewhere to reach the broker", async () => {
    await expect(
      hostPairing({ buildDescriptor: () => DESCRIPTOR, seal: sealed }),
    ).rejects.toThrow(/apiBase or a transport/);
  });
});
