import {
  cpaceStart,
  deriveSessionKeys,
  confirmationTag,
  verifyConfirmation,
  transcriptIr,
  generateSecret,
  parseCode,
  describeBadCode,
  bytesToHex,
  hexToBytes,
  randomBytes,
  utf8ToBytes,
  base64UrlToBytes,
  openOnce,
  deriveSas,
  newEphemeralKey,
  sasCommitment,
  sasSharedSecret,
  sasTranscript,
  type SessionKeys,
} from "@repo/crypto";
import {
  MAX_PEERS_PER_SLOT,
  PROTOCOL_VERSION,
  SealedDescriptor,
  codeDeadline,
  tryDeserializePairingServerMessage,
  tryDeserializeRequestServerMessage,
} from "@repo/protocol";
import { deviceLabel } from "./device-label";

/**
 * The browser half of hosted pairing, in both directions.
 *
 * `startPairing` shows a code and waits: the browser holds the mailbox and
 * generates the secret locally with crypto.getRandomValues. `joinPairing` is
 * the mirror image, used when the terminal is the one showing a code — a QR
 * scan lands on /j with the code in the fragment and the browser claims it.
 *
 * The secret is the PAKE password either way, and it is never sent anywhere:
 * not to the broker, not hashed, not in a URL the server would see. A broker
 * that never learns it cannot impersonate either side.
 *
 * ## The identity labels never swap
 *
 * `confirmationTag(key, "browser")` and `verifyConfirmation(key, "cli", …)` are
 * keyed to *who* each end is, not to which of them initiated the CPace run.
 * They stay put when the direction inverts. So do the frame direction tags:
 * `c2s` is always browser→CLI. Only the transcript ordering follows the
 * initiator, because CPace defines it that way.
 */

/**
 * The *identity* labels, bound into key confirmation.
 *
 * These are keyed to who each end is and never move. `browserAd()` below is a
 * different thing that happens to have overlapped with `AD_BROWSER` until now:
 * the associated data transmitted with a CPace share, which both ends read from
 * the wire rather than assume. Sending the literal "browser" there is why
 * `mtmux start` printed "✓ browser connected."
 */
const AD_BROWSER = "browser";
const AD_CLI = "cli";

/**
 * What this browser calls itself on the wire, for the machine to display.
 *
 * Computed once per pairing run and used in three places that must agree: the
 * `ad` field, this side's own position in the CPace transcript, and nothing
 * else. Get any one of them wrong and both ends derive different keys from a
 * correct code, which is indistinguishable from a wrong one.
 */
function browserAd(): string {
  return deviceLabel();
}

export type PairingPhase =
  | "requesting"
  | "waiting"
  | "verifying"
  | "paired"
  | "failed";

export type PairingUpdate =
  | { phase: "waiting"; code: string; expiresAt: number }
  | { phase: "verifying" }
  | { phase: "paired"; keys: SessionKeys; descriptor: SealedDescriptor }
  | { phase: "failed"; message: string };

export type PairingHandle = { cancel(): void };

type SocketFactory = (url: string) => WebSocket;

type CommonOptions = {
  apiBase: string;
  onUpdate: (update: PairingUpdate) => void;
  /** Injected in tests. */
  fetchImpl?: typeof fetch;
  socketImpl?: SocketFactory;
};

export type BrowserPairingOptions = CommonOptions;

export type JoinPairingOptions = CommonOptions & {
  /** The whole code, however the user typed or scanned it. */
  code: string;
};

/**
 * Socket base, carrying the protocol version.
 *
 * The broker answers a raw 426 from its upgrade handler for anything below its
 * floor, so `?v=` has to be on every socket this file opens — a browser that
 * omitted it would be refused exactly like a 0.6.x CLI.
 */
function wsBase(apiBase: string): string {
  return apiBase.replace(/^http/, "ws");
}

/** Appended to every socket URL. See `wsBase`. */
const V = `?v=${PROTOCOL_VERSION}`;

/** The one message a client that predates the broker's floor can act on. */
const TOO_OLD =
  "This page is out of date. Reload it — and if that does not help, update mtmux.";

// ---------------------------------------------------------------------------
// Showing a code: /pair
// ---------------------------------------------------------------------------

export function startPairing(opts: BrowserPairingOptions): PairingHandle {
  const doFetch = opts.fetchImpl ?? fetch;
  const makeSocket = opts.socketImpl ?? ((url: string) => new WebSocket(url));

  // Generated here and only here. It is never transmitted, hashed or logged.
  const secret = generateSecret();
  // Transmitted, and read by the CLI as the name to print. Fixed for the run.
  const ownAd = browserAd();
  let socket: WebSocket | null = null;
  let cancelled = false;
  let settled = false;

  function fail(message: string) {
    if (settled || cancelled) return;
    settled = true;
    socket?.close();
    opts.onUpdate({ phase: "failed", message });
  }

  void (async () => {
    let mailboxId: string;
    let slot: string;
    let expiresAt: number;
    let ttlMs: number | undefined;
    try {
      const res = await doFetch(`${opts.apiBase}/v1/pair/new`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ v: PROTOCOL_VERSION }),
      });
      if (res.status === 426) {
        fail(TOO_OLD);
        return;
      }
      if (res.status === 429) {
        fail("Too many codes requested. Wait a minute and reload.");
        return;
      }
      if (!res.ok) {
        fail("The pairing service is unavailable. Try again shortly.");
        return;
      }
      ({ mailboxId, slot, expiresAt, ttlMs } = (await res.json()) as {
        mailboxId: string;
        slot: string;
        expiresAt: number;
        ttlMs?: number;
      });
    } catch {
      fail("Could not reach the pairing service.");
      return;
    }
    if (cancelled) return;

    opts.onUpdate({
      phase: "waiting",
      code: `${slot}${secret}`,
      // On this device's clock, not the broker's — see `codeDeadline`.
      expiresAt: codeDeadline(expiresAt, ttlMs),
    });

    socket = makeSocket(`${wsBase(opts.apiBase)}/v1/pair/${mailboxId}${V}`);

    let keys: SessionKeys | null = null;
    let peerHandle: string | null = null;

    socket.onmessage = (event) => {
      const parsed = tryDeserializePairingServerMessage(event.data as string);
      if (!parsed.ok) return;
      const msg = parsed.message;

      if (msg.type === "pair:ready") {
        // The broker confirming this socket is the one that will receive the
        // claim. The code is already on screen; what is worth taking is its
        // `expiresAt`, which is the mailbox's real deadline rather than the one
        // the POST reported before the socket existed.
        opts.onUpdate({
          phase: "waiting",
          code: `${slot}${secret}`,
          expiresAt: codeDeadline(msg.expiresAt),
        });
        return;
      }

      if (msg.type === "pair:failed") {
        fail(describeFailure(msg.reason));
        return;
      }

      if (msg.type === "pair:peer-share") {
        // Bind to the first peer and stay bound. A mailbox is claimed exactly
        // once, so a share for a *different* peer means the broker offered this
        // code to two claimants — abandon it rather than run a second CPace on
        // the same secret. A repeat of the peer we already have is a duplicate
        // and is simply ignored; the run for it is already in flight.
        if (peerHandle !== null) {
          if (msg.peer !== peerHandle) {
            fail(
              "The pairing service behaved unexpectedly. Get a new code from your terminal.",
            );
          }
          return;
        }
        peerHandle = msg.peer;
        opts.onUpdate({ phase: "verifying" });

        // The claimant chose the session id, and is the initiator — so its
        // share leads the transcript.
        const cpace = cpaceStart(
          utf8ToBytes(secret),
          utf8ToBytes(slot),
          hexToBytes(msg.sid),
        );
        let isk: Uint8Array;
        try {
          isk = cpace.finish(hexToBytes(msg.share), {
            own: utf8ToBytes(ownAd),
            peer: utf8ToBytes(msg.ad),
            isInitiator: false,
          });
        } catch {
          fail("Pairing failed — the other side sent something invalid.");
          return;
        }

        keys = deriveSessionKeys(
          isk,
          transcriptIr(
            hexToBytes(msg.share),
            utf8ToBytes(msg.ad),
            cpace.share,
            utf8ToBytes(ownAd),
          ),
        );

        socket?.send(
          JSON.stringify({
            type: "pair:share",
            peer: msg.peer,
            share: bytesToHex(cpace.share),
            ad: ownAd,
          }),
        );
        socket?.send(
          JSON.stringify({
            type: "pair:confirm",
            peer: msg.peer,
            tag: bytesToHex(confirmationTag(keys.confirm, AD_BROWSER)),
          }),
        );
        return;
      }

      if (msg.type === "pair:peer-confirm") {
        if (!keys || msg.peer !== peerHandle) return;
        // A wrong code on the other machine produces a different key, so this
        // tag will not verify — and saying so destroys the mailbox, which is
        // what makes each code good for exactly one attempt.
        if (!verifyConfirmation(keys.confirm, AD_CLI, hexToBytes(msg.tag))) {
          socket?.send(
            JSON.stringify({
              type: "pair:close",
              peer: msg.peer,
              reason: "confirmation failed",
            }),
          );
          fail("That code was entered incorrectly. Reload for a new one.");
        }
        return;
      }

      if (msg.type === "pair:established") {
        if (!keys) return;
        const settledKeys = keys;
        void unsealDescriptor(settledKeys, msg.sealedDescriptor)
          .then((descriptor) => {
            if (settled || cancelled) return;
            settled = true;
            socket?.close();
            opts.onUpdate({ phase: "paired", keys: settledKeys, descriptor });
          })
          .catch(() => fail("Pairing failed — the reply could not be read."));
      }
    };

    socket.onclose = () => {
      if (!settled && !cancelled) {
        fail("Lost the connection to the pairing service.");
      }
    };
  })();

  return {
    cancel() {
      cancelled = true;
      socket?.close();
    },
  };
}

// ---------------------------------------------------------------------------
// Claiming a code: /j
// ---------------------------------------------------------------------------

/** One in-flight CPace exchange with a single candidate mailbox. */
type Attempt = { keys: SessionKeys; peerAd: string };

/**
 * How long to wait for a straggling terminal before calling a code wrong.
 *
 * Long enough that a terminal on a slow link is not mistaken for a bad code,
 * short enough that a genuinely wrong code still fails promptly.
 */
const NO_MATCH_GRACE_MS = 3_000;

/**
 * Claim a code the terminal is showing.
 *
 * A slot is deliberately shared, so this claim is offered to
 * every live mailbox holding it and several may answer. Each gets its own CPace
 * run; the one whose confirmation tag verifies is the real terminal and the
 * rest are closed, which destroys their mailboxes. Answering is therefore no
 * evidence of anything — only a tag that verifies is.
 */
export function joinPairing(opts: JoinPairingOptions): PairingHandle {
  const doFetch = opts.fetchImpl ?? fetch;
  const makeSocket = opts.socketImpl ?? ((url: string) => new WebSocket(url));

  // Transmitted, and read by the CLI as the name to print. Fixed for the run.
  const ownAd = browserAd();
  let socket: WebSocket | null = null;
  let cancelled = false;
  let settled = false;
  /**
   * Armed when the last known candidate is ruled out.
   *
   * Terminals answer independently over the network, so a decoy sharing the
   * slot can be ruled out before the real one has said anything — failing the
   * instant the counter hits zero would reject a correct code on a slow link.
   * A share arriving cancels the window.
   */
  let graceTimer: ReturnType<typeof setTimeout> | null = null;

  function clearGrace() {
    if (!graceTimer) return;
    clearTimeout(graceTimer);
    graceTimer = null;
  }

  function fail(message: string) {
    if (settled || cancelled) return;
    settled = true;
    clearGrace();
    socket?.close();
    opts.onUpdate({ phase: "failed", message });
  }

  const parsedCode = parseCode(opts.code);
  if (!parsedCode) {
    // Reported asynchronously so the caller sees it through `onUpdate` like
    // every other failure, rather than having to handle a throw as well.
    queueMicrotask(() => fail(describeBadCode(opts.code)));
    return { cancel() {} };
  }
  const { slot, secret } = parsedCode;

  void (async () => {
    opts.onUpdate({ phase: "verifying" });

    // The claimant picks the session id and is the CPace initiator, so one
    // share serves every mailbox that answers.
    const sid = randomBytes(16);
    const cpace = cpaceStart(utf8ToBytes(secret), utf8ToBytes(slot), sid);

    let claimId: string;
    try {
      const res = await doFetch(`${opts.apiBase}/v1/pair/claim`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          v: PROTOCOL_VERSION,
          slot,
          share: bytesToHex(cpace.share),
          ad: ownAd,
          sid: bytesToHex(sid),
        }),
      });
      if (res.status === 426) {
        fail(TOO_OLD);
        return;
      }
      if (res.status === 429) {
        fail("Too many attempts from this network. Wait a minute.");
        return;
      }
      if (!res.ok) {
        fail("The pairing service is unavailable. Try again shortly.");
        return;
      }
      ({ claimId } = (await res.json()) as { claimId: string });
    } catch {
      fail("Could not reach the pairing service.");
      return;
    }
    if (cancelled) return;

    // Whether anything is live on that slot is not knowable from the POST: the
    // broker fans out when this socket attaches, and says `peer-gone` there if
    // nothing was. That is deliberate — a POST that answered it was a free
    // liveness oracle over the whole code space.

    socket = makeSocket(`${wsBase(opts.apiBase)}/v1/claim/${claimId}${V}`);

    const attempts = new Map<string, Attempt>();
    /**
     * Mailboxes that could still turn out to be the terminal.
     *
     * Counted from the shares that actually arrive rather than from a number
     * the broker promised, because the broker no longer reports one — a live
     * count on a slot was an enumeration oracle for anyone who could POST.
     * `seen` is what makes "all of them were ruled out" distinguishable from
     * "none has answered yet"; the latter is left to the timeout.
     */
    let outstanding = 0;
    let seen = 0;

    function send(message: unknown) {
      socket?.send(JSON.stringify(message));
    }

    function ruleOut(peer: string) {
      attempts.delete(peer);
      outstanding -= 1;
      if (seen === 0 || outstanding > 0) return;

      // Every peer that answered has been ruled out. Once as many have answered
      // as the broker is allowed to offer, nothing else can be coming.
      if (seen >= MAX_PEERS_PER_SLOT) {
        fail("That code did not match. Get a new one from your terminal.");
        return;
      }
      graceTimer ??= setTimeout(() => {
        fail("That code did not match. Get a new one from your terminal.");
      }, NO_MATCH_GRACE_MS);
    }

    /**
     * Rule a mailbox out *and* tell the broker, which destroys it. That is the
     * whole guessing bound: one wrong code costs the code, not one of ten
     * thousand tries.
     */
    function giveUpOn(peer: string, reason: string) {
      send({ type: "pair:close", peer, reason });
      ruleOut(peer);
    }

    socket.onmessage = (event) => {
      const parsed = tryDeserializePairingServerMessage(event.data as string);
      if (!parsed.ok) return;
      const msg = parsed.message;

      if (msg.type === "pair:ready") {
        // Only a mailbox holder is ever sent this; a claim socket receiving one
        // is a broker bug, and ignoring it is the right response either way.
        return;
      }

      if (msg.type === "pair:failed") {
        // A peer-scoped failure retires one mailbox; only a failure naming no
        // peer is about this socket and ends the attempt.
        if (msg.peer) ruleOut(msg.peer);
        else fail(describeFailure(msg.reason));
        return;
      }

      if (msg.type === "pair:peer-share") {
        // A second share for a conversation already under way is either a
        // confused terminal or someone hoping to restart it under a fresh
        // scalar. Neither is a reason to abandon the run in progress.
        if (attempts.has(msg.peer)) return;

        // The broker caps live mailboxes per slot, so more answers than that
        // means it is not playing by its own rules — the shape a broker would
        // take if it were fanning a code out to attackers to multiply their
        // guesses. Refuse rather than race them.
        // A straggler arrived, so "everyone has been ruled out" was wrong.
        clearGrace();

        seen += 1;
        if (seen > MAX_PEERS_PER_SLOT) {
          fail(
            "The pairing service offered more terminals than it should. " +
              "Stop, and get a new code.",
          );
          return;
        }
        outstanding += 1;

        let isk: Uint8Array;
        try {
          isk = cpace.finish(hexToBytes(msg.share), {
            own: utf8ToBytes(ownAd),
            peer: utf8ToBytes(msg.ad),
            isInitiator: true,
          });
        } catch {
          // Not a valid group element, or the identity.
          giveUpOn(msg.peer, "invalid share");
          return;
        }

        attempts.set(msg.peer, {
          peerAd: msg.ad,
          keys: deriveSessionKeys(
            isk,
            transcriptIr(
              cpace.share,
              utf8ToBytes(ownAd),
              hexToBytes(msg.share),
              utf8ToBytes(msg.ad),
            ),
          ),
        });
        return;
      }

      if (msg.type === "pair:peer-confirm") {
        const attempt = attempts.get(msg.peer);
        if (!attempt) return;

        // The moment of truth: a wrong six-digit guess produces a different
        // key, so this tag cannot verify.
        if (
          !verifyConfirmation(attempt.keys.confirm, AD_CLI, hexToBytes(msg.tag))
        ) {
          giveUpOn(msg.peer, "confirmation failed");
          return;
        }

        // Our own tag, so the terminal can finish and seal the descriptor.
        send({
          type: "pair:confirm",
          peer: msg.peer,
          tag: bytesToHex(confirmationTag(attempt.keys.confirm, AD_BROWSER)),
        });
        return;
      }

      if (msg.type === "pair:established") {
        const attempt = attempts.get(msg.peer);
        if (!attempt) return;
        void unsealDescriptor(attempt.keys, msg.sealedDescriptor)
          .then((descriptor) => {
            if (settled || cancelled) return;
            settled = true;
            socket?.close();
            opts.onUpdate({
              phase: "paired",
              keys: attempt.keys,
              descriptor,
            });
          })
          .catch(() => fail("Pairing failed — the reply could not be read."));
      }
    };

    socket.onclose = () => {
      if (!settled && !cancelled) {
        fail("Lost the connection to the pairing service.");
      }
    };
  })();

  return {
    cancel() {
      cancelled = true;
      socket?.close();
    },
  };
}

/**
 * Open the CLI's sealed connection descriptor.
 *
 * `openOnce` reads the salt off the blob and derives the descriptor subkey
 * from it, so several candidate mailboxes can be tried in flight without a
 * failed attempt disturbing the schedule that turns out to be the real one —
 * each attempt derives its own key and keeps no state.
 *
 * This is the first thing sealed under the pairing key, so a failure here means
 * the key is wrong — which the confirmation step should already have caught.
 */
export async function unsealDescriptor(
  keys: SessionKeys,
  sealed: string,
): Promise<SealedDescriptor> {
  const opened = await openOnce(keys.s2c, "s2c", base64UrlToBytes(sealed));
  return SealedDescriptor.parse(
    JSON.parse(new TextDecoder().decode(opened)) as unknown,
  );
}

function describeFailure(reason: string): string {
  switch (reason) {
    case "expired":
      return "This code expired. Get a new one.";
    case "already-claimed":
      return "This code has already been used. Get a new one.";
    case "confirmation-failed":
      // Two causes, one code. The broker deliberately collapses every
      // peer-scoped close into this one reason — it cannot tell them apart and
      // must not be told — so the copy has to cover both: a key confirmation
      // that did not verify, and a machine whose human said no. Claiming the
      // digits were wrong to someone who watched them be refused is the worse
      // of the two errors, because it sends them to type the code again.
      return "The code did not match, or it was refused at the machine. Get a new code from your terminal.";
    case "rate-limited":
      return "Too many attempts. Wait a minute and try again.";
    case "peer-gone":
      // Reached on a claim socket when the slot held nothing. Since 0.7.0 that
      // is where "nothing is waiting" is answered — the POST is deliberately
      // silent about it — so this wording carries what the POST used to say.
      return "Nothing is waiting for that code. Check the digits, or get a new code from your terminal.";
    default:
      return "Pairing failed. Get a new code.";
  }
}

// ---------------------------------------------------------------------------
// Requesting access to a machine you already own
// ---------------------------------------------------------------------------

export type AccessRequestUpdate =
  | { phase: "asking" }
  /** The machine answered; show these digits and tell the user to compare. */
  | { phase: "confirm"; sas: string }
  | { phase: "paired"; keys: SessionKeys; descriptor: SealedDescriptor }
  /**
   * `reason` is the broker's raw code, carried alongside the prose so the UI
   * can branch without pattern-matching on a sentence. `no-tty` in particular
   * deserves a different offer from every other failure — it is the only one
   * where the machine is fine and simply has nobody in front of it.
   */
  | { phase: "failed"; message: string; reason?: string };

export type RequestAccessOptions = {
  apiBase: string;
  serverId: string;
  /** How this browser should describe itself on the machine's screen. */
  deviceLabel: string;
  onUpdate: (update: AccessRequestUpdate) => void;
  fetchImpl?: typeof fetch;
  socketImpl?: SocketFactory;
};

/**
 * Ask a machine on this account to let this browser in.
 *
 * The mirror image of `joinPairing`: instead of quoting a code the machine is
 * showing, the browser asks and a human at the machine approves by comparing
 * six digits. What makes that safe is the ordering — this commits to its
 * ephemeral key *before* it has seen the machine's, so nothing in between can
 * pick a key after the fact. See `packages/crypto/src/sas.ts`.
 */
export function requestAccess(opts: RequestAccessOptions): PairingHandle {
  const doFetch = opts.fetchImpl ?? fetch;
  const makeSocket = opts.socketImpl ?? ((url: string) => new WebSocket(url));

  let socket: WebSocket | null = null;
  let cancelled = false;
  let settled = false;

  function fail(message: string, reason?: string) {
    if (settled || cancelled) return;
    settled = true;
    socket?.close();
    opts.onUpdate({ phase: "failed", message, reason });
  }

  let pending: { keys: SessionKeys } | null = null;

  void (async () => {
    opts.onUpdate({ phase: "asking" });

    // Generated before anything is sent, and never changed. Committing to a
    // key we already hold is what makes the ordering honest.
    const ephemeral = newEphemeralKey();

    let requestId: string;
    try {
      const res = await doFetch(`${opts.apiBase}/v1/pair/request`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          v: PROTOCOL_VERSION,
          serverId: opts.serverId,
          deviceLabel: opts.deviceLabel,
        }),
      });
      if (res.status === 426) {
        fail(TOO_OLD);
        return;
      }
      if (res.status === 401) {
        fail("Sign in again, then try once more.");
        return;
      }
      if (res.status === 409) {
        const body = (await res.json()) as { error?: string };
        fail(body.error ?? "That machine is busy. Try again in a moment.");
        return;
      }
      if (!res.ok) {
        fail("Could not reach that machine. Is it online?");
        return;
      }
      ({ requestId } = (await res.json()) as { requestId: string });
    } catch {
      fail("Could not reach the pairing service.");
      return;
    }
    if (cancelled) return;

    // The commitment covers the request id, so it can only be computed once the
    // broker has minted one — hence a socket message rather than a field on the
    // POST. The machine is not disturbed until this arrives, and it answers
    // having seen a commitment and no key.
    const commitment = sasCommitment(ephemeral.publicKey, requestId);

    socket = makeSocket(`${wsBase(opts.apiBase)}/v1/request/${requestId}${V}`);
    socket.onopen = () => {
      socket?.send(
        JSON.stringify({
          type: "pair:commit",
          requestId,
          commitment: bytesToHex(commitment),
        }),
      );
    };

    socket.onmessage = (event) => {
      const parsed = tryDeserializeRequestServerMessage(event.data as string);
      if (!parsed.ok) return;
      const msg = parsed.message;

      if (msg.type === "pair:denied") {
        fail(describeDenial(msg.reason), msg.reason);
        return;
      }

      if (msg.type === "pair:request-ack") {
        // Only now is the machine's key known, and only now is ours revealed.
        void (async () => {
          try {
            const cliPublicKey = hexToBytes(msg.cliPublicKey);
            const ikm = sasSharedSecret(ephemeral.secret, cliPublicKey);
            const transcript = sasTranscript(
              requestId,
              commitment,
              ephemeral.publicKey,
              cliPublicKey,
            );
            pending = { keys: deriveSessionKeys(ikm, transcript) };
            opts.onUpdate({
              phase: "confirm",
              sas: deriveSas(ikm, transcript),
            });
            socket?.send(
              JSON.stringify({
                type: "pair:reveal",
                requestId,
                browserPublicKey: bytesToHex(ephemeral.publicKey),
              }),
            );
          } catch {
            fail("That machine offered an unusable key. Nothing was shared.");
          }
        })();
        return;
      }

      // pair:approved — the descriptor, sealed under keys only these two ends
      // hold. A failure to open it means the SAS was compared carelessly.
      void (async () => {
        if (!pending) return;
        try {
          const descriptor = await unsealDescriptor(
            pending.keys,
            msg.sealedDescriptor,
          );
          if (settled || cancelled) return;
          settled = true;
          socket?.close();
          opts.onUpdate({ phase: "paired", keys: pending.keys, descriptor });
        } catch {
          fail("Could not open the machine's reply. Try again.");
        }
      })();
    };

    socket.onclose = () => fail("Lost the connection to the pairing service.");
  })();

  return {
    cancel() {
      cancelled = true;
      socket?.close();
    },
  };
}

function describeDenial(reason: string): string {
  switch (reason) {
    case "refused":
      return "The request was refused on that machine.";
    case "commitment-failed":
      return "That machine could not verify this browser. Nothing was shared.";
    // Deliberately names no command. This used to say "Run `mtmux approve` on
    // it", which was a command that did not exist — and even now that it does,
    // it only exists on new enough CLIs. The caller offers the recovery,
    // because only the caller knows which ones apply to this machine.
    case "no-tty":
      return "Nobody is at that machine to approve the request.";
    case "timeout":
      return "Nobody answered on that machine.";
    case "agent-gone":
      return "That machine went offline.";
    case "too-many-requests":
      return "Too many requests. Wait a moment.";
    default:
      return "The request was not approved.";
  }
}
