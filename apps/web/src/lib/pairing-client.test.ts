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
  bytesToBase64Url,
  sealOnce,
  newEphemeralKey,
  sasSharedSecret,
  sasTranscript,
  deriveSas,
  verifySasCommitment,
  type SessionKeys,
} from "@repo/crypto";
import { MAX_PEERS_PER_SLOT, type SealedDescriptor } from "@repo/protocol";
import { deviceLabel } from "./device-label";
import {
  describeUnreachable,
  joinPairing,
  requestAccess,
  startPairing,
  type AccessRequestUpdate,
  type PairingUpdate,
} from "@/lib/pairing-client";

/**
 * The browser claiming a code the terminal is showing, against a scripted CLI
 * running the real CPace exchange. A transcript ordered the wrong way round
 * fails these rather than deriving two different keys from one correct code —
 * which on a real network looks exactly like a mistyped code.
 */

const DESCRIPTOR: SealedDescriptor = {
  candidates: ["http://192.168.1.5:14100"],
  tunnelId: "tnl-abcdefgh",
  deviceId: "0".repeat(16),
  publicKey: "1".repeat(64),
  label: "gagan@thinkpad",
};

const API = "http://broker.test";
const SLOT = "492";

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function fakeSocket() {
  const sent: Record<string, unknown>[] = [];
  let closed = false;
  const ws = {
    onmessage: null as ((event: { data: string }) => void) | null,
    onclose: null as (() => void) | null,
    send: (raw: string) =>
      sent.push(JSON.parse(raw) as Record<string, unknown>),
    close: () => {
      closed = true;
    },
  };
  return {
    ws: ws as unknown as WebSocket,
    sent,
    get closed() {
      return closed;
    },
    deliver: (msg: unknown) => ws.onmessage?.({ data: JSON.stringify(msg) }),
    drop: () => ws.onclose?.(),
    find: (type: string, peer?: string) =>
      sent.find(
        (m) => m.type === type && (peer === undefined || m.peer === peer),
      ) as Record<string, string> | undefined,
  };
}

/**
 * Records `onUpdate` and lets a test await a particular phase.
 *
 * Generic over the update type so the code flow and the request flow — which
 * share the shape but not the phases — can use the same harness.
 */
function recorder<U extends { phase: string }>() {
  const updates: U[] = [];
  const waiters: { phase: string; resolve: (u: U) => void }[] = [];
  return {
    updates,
    onUpdate(update: U) {
      updates.push(update);
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (waiters[i]!.phase === update.phase) {
          waiters.splice(i, 1)[0]!.resolve(update);
        }
      }
    },
    waitFor(phase: U["phase"]) {
      const seen = updates.find((u) => u.phase === phase);
      if (seen) return Promise.resolve(seen);
      return new Promise<U>((resolve) => waiters.push({ phase, resolve }));
    },
    last: () => updates[updates.length - 1],
  };
}

type Claim = { slot: string; share: string; ad: string; sid: string };

function claimHarness(opts: { answering: number; status?: number }) {
  const io = fakeSocket();
  let claim: Claim | null = null;

  const fetchImpl = ((_url: string, init?: RequestInit) => {
    claim = JSON.parse(init!.body as string) as Claim;
    const status = opts.status ?? 200;
    return Promise.resolve({
      ok: status < 400,
      status,
      // A claim id and a deadline. The POST does not look at the slot since
      // 0.7.0, so "nothing was waiting" arrives on the socket instead — see
      // the `peer-gone` the harness delivers below.
      json: () =>
        Promise.resolve({
          claimId: "clm-abcdefgh",
          expiresAt: Date.now() + 15_000,
        }),
    } as unknown as Response);
  }) as unknown as typeof fetch;

  /**
   * One terminal answering the claim: it derives its key as the CPace
   * responder, then sends its share and its tag before the browser has proved
   * anything.
   */
  function cliAnswers(peer: string, secret: string, confirmNow = true) {
    const c = claim!;
    const cpace = cpaceStart(
      utf8ToBytes(secret),
      utf8ToBytes(c.slot),
      hexToBytes(c.sid),
    );
    const peerShare = hexToBytes(c.share);
    const isk = cpace.finish(peerShare, {
      own: utf8ToBytes("cli"),
      peer: utf8ToBytes(c.ad),
      isInitiator: false,
    });
    const keys = deriveSessionKeys(
      isk,
      transcriptIr(
        peerShare,
        utf8ToBytes(c.ad),
        cpace.share,
        utf8ToBytes("cli"),
      ),
    );

    io.deliver({
      type: "pair:peer-share",
      peer,
      share: bytesToHex(cpace.share),
      ad: "cli",
      sid: c.sid,
    });
    const confirm = () =>
      io.deliver({
        type: "pair:peer-confirm",
        peer,
        tag: bytesToHex(confirmationTag(keys.confirm, "cli")),
      });
    if (confirmNow) confirm();

    return {
      keys,
      confirm,
      /** Seal the descriptor and end the exchange, as the CLI does. */
      async establish() {
        const sealed = await sealOnce(
          keys.s2c,
          "s2c",
          utf8ToBytes(JSON.stringify(DESCRIPTOR)),
        );
        io.deliver({
          type: "pair:established",
          peer,
          sealedDescriptor: bytesToBase64Url(sealed),
        });
      },
      /** Did the browser's answering tag verify on this side? */
      browserTagVerifies() {
        const confirm = io.find("pair:confirm", peer);
        return (
          confirm !== undefined &&
          verifyConfirmation(keys.confirm, "browser", hexToBytes(confirm.tag!))
        );
      },
    };
  }

  // The broker fans a claim out when its socket attaches, and answers there if
  // the slot held nothing. Scripted because it is the only way a claimant
  // learns that now.
  if (opts.answering === 0) {
    void flush().then(() =>
      io.deliver({ type: "pair:failed", reason: "peer-gone" }),
    );
  }

  return {
    io,
    fetchImpl,
    cliAnswers,
    get claim() {
      return claim;
    },
  };
}

function join(
  h: ReturnType<typeof claimHarness>,
  rec: ReturnType<typeof recorder>,
  code: string,
) {
  return joinPairing({
    apiBase: API,
    code,
    onUpdate: rec.onUpdate,
    fetchImpl: h.fetchImpl,
    socketImpl: () => h.io.ws,
  });
}

describe("joinPairing", () => {
  it("rejects a code of the wrong length before contacting the broker", async () => {
    for (const code of ["12345", "12345678", "1234567890"]) {
      const h = claimHarness({ answering: 1 });
      const rec = recorder<PairingUpdate>();
      join(h, rec, code);
      const failed = await rec.waitFor("failed");
      expect(failed).toMatchObject({ phase: "failed" });
      expect(h.claim).toBeNull();
    }
  });

  it("refuses a code minted by an mtmux from before the break", async () => {
    // 0.6.x showed eight digits on a two-digit slot. Under a three-digit slot
    // those digits would route somewhere real and derive a different key, so
    // the parse refuses them outright — clean break, not a silent misroute.
    for (const legacy of ["49271638", "492716"]) {
      const h = claimHarness({ answering: 1 });
      const rec = recorder<PairingUpdate>();
      join(h, rec, legacy);
      await rec.waitFor("failed");
      expect(h.claim).toBeNull();
    }
  });

  it("accepts spaced and dashed codes", async () => {
    const h = claimHarness({ answering: 0 });
    const rec = recorder<PairingUpdate>();
    join(h, rec, "492 716-384");
    await rec.waitFor("failed");
    expect(h.claim?.slot).toBe("492");
  });

  it("never puts the secret in the claim", async () => {
    // The most important assertion in this file. The claim body carries the
    // slot and nothing else that could reconstruct the PAKE password.
    const h = claimHarness({ answering: 0 });
    const rec = recorder<PairingUpdate>();
    join(h, rec, `${SLOT}716384`);
    await rec.waitFor("failed");
    expect(JSON.stringify(h.claim)).not.toContain("716384");
    // The associated data is a coarse device label — what the machine prints as
    // "✓ Chrome on iOS connected." It is transmitted by design, so it must stay
    // coarse: no version, no platform string, nothing near a fingerprint.
    expect(h.claim?.ad).toBe(deviceLabel());
    expect(h.claim?.ad.length).toBeLessThan(40);
  });

  it("pairs with the terminal and opens the sealed descriptor", async () => {
    const secret = "716384";
    const h = claimHarness({ answering: 1 });
    const rec = recorder<PairingUpdate>();
    join(h, rec, `${SLOT}${secret}`);
    await flush();

    const cli = h.cliAnswers("peer-0", secret);
    expect(cli.browserTagVerifies()).toBe(true);
    await cli.establish();

    const paired = (await rec.waitFor("paired")) as Extract<
      PairingUpdate,
      { phase: "paired" }
    >;
    expect(paired.descriptor).toEqual(DESCRIPTOR);
    expect(bytesToHex(paired.keys.c2s)).toBe(bytesToHex(cli.keys.c2s));
    expect(paired.keys.directToken).toBe(cli.keys.directToken);
  });

  it("keeps the terminal whose tag verifies and closes every decoy", async () => {
    const secret = "716384";
    const h = claimHarness({ answering: 2 });
    const rec = recorder<PairingUpdate>();
    join(h, rec, `${SLOT}${secret}`);
    await flush();

    h.cliAnswers("peer-0", "000000");
    const real = h.cliAnswers("peer-1", secret);
    await real.establish();

    const paired = (await rec.waitFor("paired")) as Extract<
      PairingUpdate,
      { phase: "paired" }
    >;
    expect(bytesToHex(paired.keys.c2s)).toBe(bytesToHex(real.keys.c2s));

    // Closing a decoy destroys its mailbox — one guess per code, even when the
    // slot is shared by two pairings at once.
    expect(h.io.find("pair:close", "peer-0")).toBeDefined();
    expect(h.io.find("pair:close", "peer-1")).toBeUndefined();
  });

  it("refuses a broker offering more peers than a slot may hold", async () => {
    // The cap is what stops a mailbox-squatting attacker buying extra tries at
    // a code, so a broker exceeding it is the one thing a claimant can detect
    // on its own — and the only safe response is to stop.
    const h = claimHarness({ answering: MAX_PEERS_PER_SLOT + 1 });
    const rec = recorder<PairingUpdate>();
    join(h, rec, `${SLOT}716384`);
    await flush();

    // Shares only: the refusal must rest on the count alone, before any of
    // them is ruled out on its tag.
    for (let i = 0; i <= MAX_PEERS_PER_SLOT; i += 1) {
      h.cliAnswers(`peer-${i}`, "000000", false);
    }

    const failed = (await rec.waitFor("failed")) as Extract<
      PairingUpdate,
      { phase: "failed" }
    >;
    expect(failed.message).toMatch(/more terminals than it should/);
  });

  it("fails once every offered mailbox has been ruled out", async () => {
    const h = claimHarness({ answering: 2 });
    const rec = recorder<PairingUpdate>();
    join(h, rec, `${SLOT}716384`);
    await flush();
    h.cliAnswers("peer-0", "000000");
    h.cliAnswers("peer-1", "999999");

    const failed = (await rec.waitFor("failed")) as Extract<
      PairingUpdate,
      { phase: "failed" }
    >;
    expect(failed.message).toMatch(/did not match/);
  });

  it("refuses a tampered confirmation tag", async () => {
    const secret = "716384";
    const h = claimHarness({ answering: 1 });
    const rec = recorder<PairingUpdate>();
    join(h, rec, `${SLOT}${secret}`);
    await flush();

    const c = h.claim!;
    const cpace = cpaceStart(
      utf8ToBytes(secret),
      utf8ToBytes(c.slot),
      hexToBytes(c.sid),
    );
    h.io.deliver({
      type: "pair:peer-share",
      peer: "peer-0",
      share: bytesToHex(cpace.share),
      ad: "cli",
      sid: c.sid,
    });
    h.io.deliver({
      type: "pair:peer-confirm",
      peer: "peer-0",
      tag: "a".repeat(64),
    });

    await rec.waitFor("failed");
    expect(h.io.find("pair:close", "peer-0")).toBeDefined();
    expect(h.io.find("pair:confirm", "peer-0")).toBeUndefined();
  });

  it("refuses a share that is not a valid group element", async () => {
    const h = claimHarness({ answering: 1 });
    const rec = recorder<PairingUpdate>();
    join(h, rec, `${SLOT}716384`);
    await flush();
    h.io.deliver({
      type: "pair:peer-share",
      peer: "peer-evil",
      share: "f".repeat(64),
      ad: "cli",
      sid: h.claim!.sid,
    });
    await rec.waitFor("failed");
    expect(h.io.find("pair:close", "peer-evil")).toBeDefined();
  });

  it("ignores a second share for a conversation already under way", async () => {
    const secret = "716384";
    const h = claimHarness({ answering: 1 });
    const rec = recorder<PairingUpdate>();
    join(h, rec, `${SLOT}${secret}`);
    await flush();

    const cli = h.cliAnswers("peer-0", secret);
    h.io.deliver({
      type: "pair:peer-share",
      peer: "peer-0",
      share: "f".repeat(64),
      ad: "cli",
      sid: h.claim!.sid,
    });
    expect(h.io.find("pair:close", "peer-0")).toBeUndefined();

    await cli.establish();
    const paired = (await rec.waitFor("paired")) as Extract<
      PairingUpdate,
      { phase: "paired" }
    >;
    expect(bytesToHex(paired.keys.c2s)).toBe(bytesToHex(cli.keys.c2s));
  });

  it("reports a code nobody is waiting for", async () => {
    const h = claimHarness({ answering: 0 });
    const rec = recorder<PairingUpdate>();
    join(h, rec, `${SLOT}716384`);
    const failed = (await rec.waitFor("failed")) as Extract<
      PairingUpdate,
      { phase: "failed" }
    >;
    expect(failed.message).toMatch(/Nothing is waiting/);
  });

  it("reports being rate limited", async () => {
    const h = claimHarness({ answering: 1, status: 429 });
    const rec = recorder<PairingUpdate>();
    join(h, rec, `${SLOT}716384`);
    const failed = (await rec.waitFor("failed")) as Extract<
      PairingUpdate,
      { phase: "failed" }
    >;
    expect(failed.message).toMatch(/Too many/);
  });

  it("surfaces a lost broker connection", async () => {
    const h = claimHarness({ answering: 1 });
    const rec = recorder<PairingUpdate>();
    join(h, rec, `${SLOT}716384`);
    await flush();
    h.io.drop();
    const failed = (await rec.waitFor("failed")) as Extract<
      PairingUpdate,
      { phase: "failed" }
    >;
    expect(failed.message).toMatch(/Lost the connection/);
  });

  it("stops reacting once cancelled", async () => {
    const secret = "716384";
    const h = claimHarness({ answering: 1 });
    const rec = recorder<PairingUpdate>();
    const handle = join(h, rec, `${SLOT}${secret}`);
    await flush();
    handle.cancel();
    const cli = h.cliAnswers("peer-0", secret);
    await cli.establish();
    await flush();
    expect(rec.updates.some((u) => u.phase === "paired")).toBe(false);
  });
});

describe("startPairing", () => {
  function newHarness(expiresAt: number) {
    const io = fakeSocket();
    const fetchImpl = (() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            mailboxId: "mbx-abcdefgh",
            slot: SLOT,
            expiresAt,
          }),
      } as unknown as Response)) as unknown as typeof fetch;
    return { io, fetchImpl };
  }

  it("shows a nine-digit code whose first three digits are the broker's slot", async () => {
    const h = newHarness(Date.now() + 180_000);
    const rec = recorder<PairingUpdate>();
    startPairing({
      apiBase: API,
      onUpdate: rec.onUpdate,
      fetchImpl: h.fetchImpl,
      socketImpl: () => h.io.ws,
    });
    const waiting = (await rec.waitFor("waiting")) as Extract<
      PairingUpdate,
      { phase: "waiting" }
    >;
    expect(waiting.code).toMatch(/^\d{9}$/);
    expect(waiting.code.slice(0, 3)).toBe(SLOT);
  });

  it("takes the mailbox's own deadline from pair:ready", async () => {
    const fromPost = Date.now() + 180_000;
    const fromSocket = fromPost - 5_000;
    const h = newHarness(fromPost);
    const rec = recorder<PairingUpdate>();
    startPairing({
      apiBase: API,
      onUpdate: rec.onUpdate,
      fetchImpl: h.fetchImpl,
      socketImpl: () => h.io.ws,
    });
    const first = (await rec.waitFor("waiting")) as Extract<
      PairingUpdate,
      { phase: "waiting" }
    >;

    h.io.deliver({
      type: "pair:ready",
      mailboxId: "mbx-abcdefgh",
      slot: SLOT,
      expiresAt: fromSocket,
    });

    const updates = rec.updates.filter((u) => u.phase === "waiting") as Extract<
      PairingUpdate,
      { phase: "waiting" }
    >[];
    expect(updates).toHaveLength(2);
    // Same code, the broker's authoritative expiry.
    expect(updates[1]!.code).toBe(first.code);
    expect(updates[1]!.expiresAt).toBe(fromSocket);
  });

  it("pairs with a terminal that claims its code", async () => {
    const h = newHarness(Date.now() + 180_000);
    const rec = recorder<PairingUpdate>();
    startPairing({
      apiBase: API,
      onUpdate: rec.onUpdate,
      fetchImpl: h.fetchImpl,
      socketImpl: () => h.io.ws,
    });
    const waiting = (await rec.waitFor("waiting")) as Extract<
      PairingUpdate,
      { phase: "waiting" }
    >;
    const secret = waiting.code.slice(3);

    // The CLI claims it: initiator, and it picks the sid.
    const sid = "b".repeat(32);
    const cpace = cpaceStart(
      utf8ToBytes(secret),
      utf8ToBytes(SLOT),
      hexToBytes(sid),
    );
    h.io.deliver({
      type: "pair:peer-share",
      peer: "peer-0",
      share: bytesToHex(cpace.share),
      ad: "cli",
      sid,
    });

    const share = h.io.find("pair:share", "peer-0")!;
    const isk = cpace.finish(hexToBytes(share.share!), {
      own: utf8ToBytes("cli"),
      peer: utf8ToBytes(share.ad!),
      isInitiator: true,
    });
    const keys: SessionKeys = deriveSessionKeys(
      isk,
      transcriptIr(
        cpace.share,
        utf8ToBytes("cli"),
        hexToBytes(share.share!),
        utf8ToBytes(share.ad!),
      ),
    );

    const browserTag = h.io.find("pair:confirm", "peer-0")!;
    expect(
      verifyConfirmation(keys.confirm, "browser", hexToBytes(browserTag.tag!)),
    ).toBe(true);

    h.io.deliver({
      type: "pair:peer-confirm",
      peer: "peer-0",
      tag: bytesToHex(confirmationTag(keys.confirm, "cli")),
    });
    const sealed = await sealOnce(
      keys.s2c,
      "s2c",
      utf8ToBytes(JSON.stringify(DESCRIPTOR)),
    );
    h.io.deliver({
      type: "pair:established",
      peer: "peer-0",
      sealedDescriptor: bytesToBase64Url(sealed),
    });

    const paired = (await rec.waitFor("paired")) as Extract<
      PairingUpdate,
      { phase: "paired" }
    >;
    expect(paired.descriptor).toEqual(DESCRIPTOR);
    expect(paired.keys.directToken).toBe(keys.directToken);
  });

  /**
   * A mailbox is claimed exactly once, so a second peer-share is the broker
   * misbehaving — and the holder must not simply follow it. It used to: the
   * handler assigned `peerHandle = msg.peer` unconditionally, so a second share
   * silently started a fresh CPace run against the same six digits and the
   * page's own state moved to whoever spoke last.
   */
  function hosting() {
    const h = newHarness(Date.now() + 180_000);
    const rec = recorder<PairingUpdate>();
    startPairing({
      apiBase: API,
      onUpdate: rec.onUpdate,
      fetchImpl: h.fetchImpl,
      socketImpl: () => h.io.ws,
    });
    return { h, rec };
  }

  function shareFrom(
    h: { io: ReturnType<typeof fakeSocket> },
    peer: string,
    secret: string,
  ) {
    const sid = "b".repeat(32);
    const cpace = cpaceStart(
      utf8ToBytes(secret),
      utf8ToBytes(SLOT),
      hexToBytes(sid),
    );
    h.io.deliver({
      type: "pair:peer-share",
      peer,
      share: bytesToHex(cpace.share),
      ad: "cli",
      sid,
    });
  }

  it("binds to the first peer and refuses a share from a second", async () => {
    const { h, rec } = hosting();
    const waiting = (await rec.waitFor("waiting")) as Extract<
      PairingUpdate,
      { phase: "waiting" }
    >;
    const secret = waiting.code.slice(3);

    shareFrom(h, "peer-0", secret);
    expect(h.io.find("pair:share", "peer-0")).toBeDefined();

    shareFrom(h, "peer-1", secret);
    expect(h.io.find("pair:share", "peer-1")).toBeUndefined();
    const failed = (await rec.waitFor("failed")) as Extract<
      PairingUpdate,
      { phase: "failed" }
    >;
    expect(failed.message).toMatch(/behaved unexpectedly/);
  });

  it("ignores a repeat of the peer it is already talking to", async () => {
    // A duplicate is not an attack — the run for it is already in flight — so
    // it must not fail the pairing either. Answering it twice would be the
    // second CPace run this rule exists to prevent.
    const { h, rec } = hosting();
    const waiting = (await rec.waitFor("waiting")) as Extract<
      PairingUpdate,
      { phase: "waiting" }
    >;
    const secret = waiting.code.slice(3);

    shareFrom(h, "peer-0", secret);
    shareFrom(h, "peer-0", secret);

    expect(
      h.io.sent.filter((m) => m.type === "pair:share" && m.peer === "peer-0"),
    ).toHaveLength(1);
    expect(rec.updates.some((u) => u.phase === "failed")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// requestAccess — the browser asking a machine it already owns
// ---------------------------------------------------------------------------

/**
 * The mirror image of the code flow: nobody types anything, and what makes it
 * safe is the *ordering*. The browser commits to an ephemeral key it already
 * holds, and only reveals that key once the machine's is in hand — so the
 * machine cannot choose its key after seeing the browser's and steer the six
 * digits both screens will show to a value it picked.
 *
 * The CLI stand-in below runs the real `@repo/crypto` maths on the other side,
 * so a transcript assembled in the wrong order produces two different SAS
 * values here rather than passing.
 */
function requestHarness() {
  const io = fakeSocket();
  const cli = newEphemeralKey();
  let requestId = "";

  const fetchImpl = ((url: string) => {
    expect(url).toContain("/v1/pair/request");
    requestId = "req-abcdefgh";
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ requestId }),
    } as unknown as Response);
  }) as unknown as typeof fetch;

  return {
    io,
    cli,
    fetchImpl,
    socketImpl: () => io.ws,
    get requestId() {
      return requestId;
    },

    /** Let the POST settle, then open the socket the client just created. */
    async open() {
      await flush();
      (io.ws as unknown as { onopen?: () => void }).onopen?.();
      await flush();
    },

    /** The machine answering: it publishes its key, having seen a commitment. */
    ack() {
      io.deliver({
        type: "pair:request-ack",
        requestId,
        cliPublicKey: bytesToHex(cli.publicKey),
      });
    },

    /** What the machine's own screen would show, computed independently. */
    async approve() {
      const reveal = io.find("pair:reveal")!;
      const browserPublicKey = hexToBytes(reveal.browserPublicKey!);
      const commitment = hexToBytes(io.find("pair:commit")!.commitment!);
      const ikm = sasSharedSecret(cli.secret, browserPublicKey);
      const transcript = sasTranscript(
        requestId,
        commitment,
        browserPublicKey,
        cli.publicKey,
      );
      const keys = deriveSessionKeys(ikm, transcript);
      const sealed = await sealOnce(
        keys.s2c,
        "s2c",
        utf8ToBytes(JSON.stringify(DESCRIPTOR)),
      );
      io.deliver({
        type: "pair:approved",
        requestId,
        sealedDescriptor: bytesToBase64Url(sealed),
      });
      return {
        sas: deriveSas(ikm, transcript),
        commitmentOk: verifySasCommitment(
          commitment,
          browserPublicKey,
          requestId,
        ),
      };
    },
  };
}

describe("requestAccess", () => {
  it("never reveals its key before the machine has published one", async () => {
    const h = requestHarness();
    const rec = recorder<AccessRequestUpdate>();

    requestAccess({
      apiBase: API,
      serverId: "srv-1",
      deviceLabel: "Chrome on macOS",
      onUpdate: rec.onUpdate,
      fetchImpl: h.fetchImpl,
      socketImpl: h.socketImpl,
    });
    await h.open();

    // This is the security property, asserted directly rather than inferred
    // from a passing handshake. A reveal at this point would let the machine
    // pick its key afterwards and steer the digits to anything it liked.
    expect(h.io.find("pair:commit")).toBeDefined();
    expect(h.io.find("pair:reveal")).toBeUndefined();

    h.ack();
    // Waiting on the *update* rather than a fixed number of microtask flushes:
    // the ack handler awaits real HKDF, so a bare `flush()` is a bet on how
    // many turns that takes — one this suite lost exactly once, under load.
    await rec.waitFor("confirm");

    expect(h.io.find("pair:reveal")).toBeDefined();
  });

  it("shows the same six digits the machine computes, and pairs", async () => {
    const h = requestHarness();
    const rec = recorder<AccessRequestUpdate>();

    requestAccess({
      apiBase: API,
      serverId: "srv-1",
      deviceLabel: "Chrome on macOS",
      onUpdate: rec.onUpdate,
      fetchImpl: h.fetchImpl,
      socketImpl: h.socketImpl,
    });
    await h.open();
    h.ack();
    const confirm = await rec.waitFor("confirm");

    const { sas, commitmentOk } = await h.approve();
    await rec.waitFor("paired");

    // The commitment the browser sent really does open to the key it later
    // revealed — which is what the machine checks before showing its digits.
    expect(commitmentOk).toBe(true);
    expect((confirm as { sas: string }).sas).toBe(sas);
    expect(sas).toMatch(/^\d{6}$/);

    const paired = rec.updates.find((u) => u.phase === "paired");
    expect(paired).toBeDefined();
    expect((paired as { descriptor: SealedDescriptor }).descriptor).toEqual(
      DESCRIPTOR,
    );
  });

  it("carries the denial reason, so the UI can offer the right way out", async () => {
    const h = requestHarness();
    const rec = recorder<AccessRequestUpdate>();

    requestAccess({
      apiBase: API,
      serverId: "srv-1",
      deviceLabel: "Chrome on macOS",
      onUpdate: rec.onUpdate,
      fetchImpl: h.fetchImpl,
      socketImpl: h.socketImpl,
    });
    await h.open();

    h.io.deliver({
      type: "pair:denied",
      requestId: h.requestId,
      reason: "no-tty",
    });
    const failed = (await rec.waitFor("failed")) as {
      message: string;
      reason?: string;
    };
    expect(failed.reason).toBe("no-tty");
    // The prose must not name a command — which recovery applies depends on the
    // machine's CLI version, and only the caller knows that.
    expect(failed.message).not.toMatch(/mtmux approve/);
  });
});

describe("describeUnreachable", () => {
  /*
   * A claim from a page `mtmux start` served itself is refused by the broker's
   * CORS allow-list before it leaves the browser, and a CORS refusal reaches
   * `fetch` as the same opaque TypeError an offline machine produces. The old
   * message guessed between them and guessed wrong: it blamed a service that
   * was running and left the user reloading a page that could never work.
   *
   * The allow-list is not the bug. `apps/api/src/config.ts` refuses to boot in
   * production with localhost in `API_CORS_ORIGINS`, on purpose. So the answer
   * is to say where claiming *does* work, which this page can name exactly.
   */
  it("names both origins when the page is not the app", () => {
    const message = describeUnreachable(
      "https://api.mtmux.com",
      "http://localhost:39500",
    );
    expect(message).toContain("localhost:39500");
    expect(message).toContain("app.mtmux.com");
    expect(message).toContain("token");
  });

  it("says only the plain sentence on the app itself", () => {
    expect(
      describeUnreachable("https://api.mtmux.com", "https://app.mtmux.com"),
    ).toBe("Could not reach the pairing service.");
  });

  /*
   * A single-origin self-host serves the broker and the app from one place, so
   * the `api.` → `app.` swap is a no-op and the two match. Telling that
   * operator to go and use a different host would be inventing one.
   */
  it("does not invent a second origin for a single-origin deployment", () => {
    expect(
      describeUnreachable(
        "https://mtmux.example.com",
        "https://mtmux.example.com",
      ),
    ).toBe("Could not reach the pairing service.");
  });

  it("has nothing to compare on the server", () => {
    expect(describeUnreachable("https://api.mtmux.com", null)).toBe(
      "Could not reach the pairing service.",
    );
  });
});
