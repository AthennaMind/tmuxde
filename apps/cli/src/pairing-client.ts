import WebSocket from "ws";
import {
  cpaceStart,
  deriveSessionKeys,
  transcriptIr,
  bytesToHex,
  hexToBytes,
  randomBytes,
  utf8ToBytes,
  generateSecret,
  parseCode,
  describeBadCode,
  type SessionKeys,
} from "@repo/crypto";
import {
  MAX_PEERS_PER_SLOT,
  PROTOCOL_VERSION,
  PairClaimResponse,
  PairNewResponse,
  codeDeadline,
  type SealedDescriptor,
  type SlotSpace,
} from "@repo/protocol";
import {
  AD_CLI,
  AD_PEER_MAX,
  PairingError,
  describeFailure,
  runExchange,
  type Derived,
  type Exchange,
  type PairingResult,
  type PairingSocket,
} from "./pairing-exchange.js";

/**
 * The CLI half of hosted pairing, in both directions.
 *
 * `pairWithCode` is the original: the user reads a code off their phone and
 * types it here. `hostPairing` is the mirror image, which is what `mtmux start`
 * prints as a code and a QR — the CLI parks the mailbox and a browser claims
 * it, so nothing has to be typed on the machine at all.
 *
 * In both, only the leading slot digits are the broker's routing half; the rest
 * is the PAKE password. Whichever side generates the secret, it never leaves
 * that process — not to the broker, not hashed, not in a log line. Any secret a
 * human could retype is an instant offline search, so a broker that learned the
 * whole code could run the PAKE against both ends at once and hand an attacker
 * a shell.
 *
 * The exchange itself — fan-out across candidate peers, key confirmation,
 * sealing the descriptor — lives in `pairing-exchange.ts` and is shared, so the
 * two directions cannot drift apart.
 */

export type {
  PairingResult,
  PairingSocket,
  PairingErrorKind,
  Attempt,
} from "./pairing-exchange.js";
export { PairingError } from "./pairing-exchange.js";

/** Claiming a code someone else is showing. */
export type ClaimTransport = {
  postClaim(body: unknown): Promise<{ claimId: string }>;
  openClaimSocket(claimId: string): Promise<PairingSocket>;
};

/** Showing a code and waiting for someone to claim it. */
export type MailboxTransport = {
  postMailbox(space?: SlotSpace): Promise<{
    mailboxId: string;
    slot: string;
    expiresAt: number;
    ttlMs?: number;
  }>;
  openMailboxSocket(mailboxId: string): Promise<PairingSocket>;
};

/** Both halves. `httpTransport` implements all of it. */
export type PairingTransport = ClaimTransport & MailboxTransport;

/** How long a claimed pairing may sit half-finished before we give up. */
const CLAIM_TIMEOUT_MS = 30_000;

/**
 * How long to wait on a hosted code, preferring a duration to a deadline.
 *
 * See `codeDeadline`: without the clamp, a CLI whose clock runs three minutes
 * fast times out every code it arms the instant it arms it, burns its whole
 * re-arm budget in milliseconds, and goes idle before the banner has finished
 * printing.
 */
export function mailboxTimeoutMs(
  expiresAt: number,
  ttlMs?: number,
  now: number = Date.now(),
): number {
  return codeDeadline(expiresAt, ttlMs, now) - now;
}

// ---------------------------------------------------------------------------
// Claiming: `mtmux pair <code>`
// ---------------------------------------------------------------------------

export type PairOptions = {
  code: string;
  transport: ClaimTransport;
  /** Built once the key is known, so the CLI can seal it for this peer. */
  buildDescriptor: () => SealedDescriptor;
  /** Seals the descriptor under the session key. */
  seal: (
    keys: SessionKeys,
    descriptor: SealedDescriptor,
  ) => Promise<Uint8Array>;
  timeoutMs?: number;
};

export async function pairWithCode(opts: PairOptions): Promise<PairingResult> {
  const parsed = parseCode(opts.code);
  if (!parsed) {
    throw new PairingError(
      describeBadCode(opts.code),
      "Open app.mtmux.com/pair on your phone and read the code it shows.",
    );
  }
  const { slot, secret } = parsed;

  // The claimant picks the CPace session id, and is the initiator: the
  // transcript is ordered initiator-first, so our share leads it.
  const sid = randomBytes(16);
  const channelId = utf8ToBytes(slot);
  const cpace = cpaceStart(utf8ToBytes(secret), channelId, sid);

  const { claimId } = await opts.transport.postClaim({
    slot,
    share: bytesToHex(cpace.share),
    ad: AD_CLI,
    sid: bytesToHex(sid),
  });

  // Whether anything is waiting on that slot is not knowable from the POST any
  // more — the broker fans out when the socket attaches, and answers with
  // `pair:failed / peer-gone` there if nothing was live. `runExchange` already
  // renders that.

  const socket = await opts.transport.openClaimSocket(claimId);

  const hint =
    "Each code is good for one attempt. Reload the page for a new one.";
  return runExchange({
    socket,
    side: "claim",
    maxPeers: MAX_PEERS_PER_SLOT,
    buildDescriptor: opts.buildDescriptor,
    seal: opts.seal,
    timeoutMs: opts.timeoutMs ?? CLAIM_TIMEOUT_MS,
    derive: (msg) => {
      if (msg.ad.length > AD_PEER_MAX) {
        return { reject: "oversized associated data" };
      }
      let isk: Uint8Array;
      try {
        isk = cpace.finish(hexToBytes(msg.share), {
          own: utf8ToBytes(AD_CLI),
          peer: utf8ToBytes(msg.ad),
          isInitiator: true,
        });
      } catch {
        // A share that is not a valid group element, or is the identity.
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
              cpace.share,
              utf8ToBytes(AD_CLI),
              hexToBytes(msg.share),
              utf8ToBytes(msg.ad),
            ),
          ),
        },
      };
    },
    errors: {
      noMatch: () => new PairingError("That code did not match.", hint),
      timedOut: () =>
        new PairingError(
          "Pairing timed out.",
          "Check that the page is still open, then try a fresh code.",
        ),
      lost: () =>
        new PairingError(
          "Lost the connection to the pairing service.",
          "Check your network and try again.",
        ),
      tooManyPeers: () =>
        new PairingError(
          "The pairing service offered more terminals than it should.",
          "Stopped rather than risk pairing with the wrong one. Get a new code.",
        ),
      failed: (reason) => new PairingError(describeFailure(reason), hint),
    },
  }).result;
}

// ---------------------------------------------------------------------------
// Hosting: the code `mtmux start` prints
// ---------------------------------------------------------------------------

export type HostedPairing = {
  /**
   * Slot and secret concatenated: nine digits for a typed secret, or slot + 22
   * base64url characters when `secret` was a long one. `mtmux start` shows the
   * first and puts the second in the QR.
   */
  code: string;
  slot: string;
  expiresAt: number;
  /** Resolves when a browser completes the handshake. */
  paired: Promise<PairingResult>;
  cancel(): void;
};

export type HostOptions = {
  /** Where the broker lives. Ignored when `transport` is supplied. */
  apiBase?: string;
  /** Injected by tests, and by anything that is not talking to a real broker. */
  transport?: MailboxTransport;
  /**
   * The PAKE password to park this mailbox under. Defaults to typed digits.
   *
   * `mtmux start` supplies a 128-bit one for the mailbox behind the QR, since
   * nothing has to read that off a screen. A mailbox commits to one password
   * when it answers, so the two forms need a mailbox each.
   */
  secret?: string;
  /**
   * Which slot space to park in. Defaults to `typed`, which is also what a
   * broker that has never heard of the field will give you.
   */
  space?: SlotSpace;
  /** Built once the key is known, so the CLI can seal it for this peer. */
  buildDescriptor: () => SealedDescriptor;
  seal: (
    keys: SessionKeys,
    descriptor: SealedDescriptor,
  ) => Promise<Uint8Array>;
  /**
   * The yes/no at the machine, asked after the key has proved who this is and
   * before the descriptor is sealed for them.
   *
   * Optional only because `hostPairing` is also driven by tests that have
   * nobody to ask. **Every caller that faces a real user must pass one**:
   * without it, knowing the code *is* the approval, and the code is read off
   * a screen and typed somewhere else — so what it proves is that somebody
   * saw the screen, not that the person holding the browser is you.
   *
   * This declaration is the fix for a bug worth naming. `ExchangeOptions.admit`
   * has existed, been documented and been honoured by `pairing-exchange.ts`
   * since the gate was written — but it was never declared here and never
   * forwarded, so `mtmux start` set `admit: confirmCodePairing` on an object
   * that quietly dropped it. A spread into a call site takes no excess-property
   * check, so nothing said a word: the seam was live at one end and unwired at
   * the other, and every hosted pairing completed without a soul being asked.
   */
  admit?: (peerLabel: string) => Promise<boolean>;
  /**
   * Overrides the deadline, which otherwise tracks the mailbox's own expiry.
   * A hosted code is dead the moment the broker forgets its mailbox, so
   * matching that is almost always what you want.
   */
  timeoutMs?: number;
};

/**
 * Park a mailbox and wait for a browser to claim it.
 *
 * Re-arming is deliberately just calling this again with the same options:
 * nothing is carried between codes. Every call generates a fresh six-digit
 * secret, opens a fresh mailbox on a fresh slot, and takes a fresh socket, so a
 * spent code shares no state with its replacement — which is what makes "one
 * guess burns the code" survive re-arming.
 *
 *     let hosted = await hostPairing(opts);
 *     render(hosted.code);
 *     hosted.paired.then(onPaired).catch(async () => {
 *       hosted = await hostPairing(opts);   // same options, new code
 *       render(hosted.code);
 *     });
 */
export async function hostPairing(opts: HostOptions): Promise<HostedPairing> {
  // Generated here by default, and wherever it comes from it is never
  // transmitted, hashed or logged — the broker mints the slot, and that is all
  // it is ever told.
  const secret = opts.secret ?? generateSecret();

  if (!opts.transport && !opts.apiBase) {
    throw new PairingError("hostPairing needs an apiBase or a transport.");
  }
  const transport = opts.transport ?? httpTransport(opts.apiBase!);
  const { mailboxId, slot, expiresAt, ttlMs } = await transport.postMailbox(
    opts.space,
  );
  const socket = await transport.openMailboxSocket(mailboxId);
  const channelId = utf8ToBytes(slot);

  const hint = "Each code is good for one attempt — a new one is on its way.";
  const exchange: Exchange = runExchange({
    socket,
    side: "mailbox",
    // One claim per mailbox, and now one *ever*: fan-out and burn are the same
    // instant, so a mailbox that has answered a peer can never be offered to a
    // second one. A second peer here is the broker misbehaving, and refusing it
    // is the holder's own check on that rather than trust in the broker.
    maxPeers: 1,
    // No straggler window: ruling a peer out means its confirmation failed, and
    // the broker destroys the mailbox on that — so nothing further can arrive
    // and there is nothing to wait for.
    noMatchGraceMs: 0,
    buildDescriptor: opts.buildDescriptor,
    seal: opts.seal,
    // Forwarded rather than defaulted: `runExchange` reads absence as "no gate
    // installed", and which callers have one has to stay readable here. This
    // line is the whole of the fix — the option was set by `mtmux start` and
    // landed nowhere.
    ...(opts.admit ? { admit: opts.admit } : {}),
    // The mailbox stops existing at `expiresAt`, so a deadline past it would
    // only mean waiting on a socket the broker has already given up on.
    timeoutMs: opts.timeoutMs ?? mailboxTimeoutMs(expiresAt, ttlMs),
    derive: (msg): Derived => {
      if (msg.ad.length > AD_PEER_MAX) {
        return { reject: "oversized associated data" };
      }
      // The claimant chose the session id, so the CPace run can only start now
      // — one per peer, unlike the claiming direction where our share is fixed
      // before the first peer is known.
      const cpace = cpaceStart(
        utf8ToBytes(secret),
        channelId,
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
          // Initiator-first, and here the *claimant* is the initiator — so the
          // peer's share leads the transcript. Getting this backwards derives
          // two different keys from one correct code, which looks exactly like
          // a wrong code.
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
    },
    errors: {
      noMatch: () =>
        new PairingError("That code did not match.", hint, "no-match"),
      timedOut: () =>
        new PairingError(
          "The pairing code expired before anyone used it.",
          "A fresh code is on its way.",
          // Nobody engaged with this code at all. `startHosted` counts these:
          // an unwatched terminal must stop minting fresh codes eventually.
          "expired",
        ),
      lost: () =>
        new PairingError(
          "Lost the connection to the pairing service.",
          "Check your network — the code will be retried.",
          "lost",
        ),
      // A mailbox is claimed once, so a second peer means the broker offered
      // this code to two claimants. Nothing to do but abandon the code.
      tooManyPeers: () =>
        new PairingError(
          "The pairing service behaved unexpectedly.",
          "A fresh code is on its way.",
        ),
      failed: (reason) => new PairingError(describeFailure(reason), hint),
    },
  });

  // A caller that re-arms will usually cancel a code it is no longer awaiting,
  // and in Node an unhandled rejection is fatal. This inert handler defuses
  // that; the promise handed back is the same one, so the caller's own
  // `await`/`.catch` still sees every rejection.
  exchange.result.catch(() => {});

  let cancelled = false;
  return {
    code: `${slot}${secret}`,
    slot,
    expiresAt,
    paired: exchange.result,
    cancel() {
      if (cancelled) return;
      cancelled = true;
      // Tell the broker before dropping the socket: a peerless `pair:close`
      // destroys the mailbox now rather than leaving a dead code claimable for
      // the rest of its three minutes.
      try {
        socket.send({ type: "pair:close", reason: "cancelled" });
      } catch {
        // Socket already gone; the abort below is what matters.
      }
      exchange.abort(new PairingError("Pairing cancelled."));
    },
  };
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

/** How many times to ask for a mailbox before giving up on the broker. */
const MAILBOX_POST_ATTEMPTS = 3;

const delay = (ms: number) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });

/**
 * How long to wait before asking again, from the broker's `Retry-After`.
 *
 * Jittered on top of whatever it says, because every agent on the service reads
 * the same header at the same moment: honouring it exactly means they all come
 * back together and collide on the slot space again.
 */
export function retryAfterMs(
  header: string | null,
  random: () => number = Math.random,
): number {
  const seconds = Number(header);
  const base = Number.isFinite(seconds) && seconds > 0 ? seconds : 3;
  return Math.round((base + random() * 5) * 1000);
}

/** Default transport: real HTTP + WebSocket against the broker. */
export function httpTransport(apiBase: string): PairingTransport {
  /** The one message a client that is too old can act on. */
  function tooOld(): PairingError {
    return new PairingError(
      "This version of mtmux is too old to pair.",
      "Run: npm i -g mtmux@latest",
    );
  }

  function openSocket(path: string): Promise<PairingSocket> {
    // `?v=` on the socket as well as in the body: the broker answers a raw 426
    // from its upgrade handler, before any frames, so a client that is too old
    // learns it from the handshake rather than from a close code it would have
    // to guess the meaning of.
    const ws = new WebSocket(
      `${apiBase.replace(/^http/, "ws")}${path}?v=${PROTOCOL_VERSION}`,
    );
    return new Promise((resolve, reject) => {
      ws.once("unexpected-response", (_req, res) => {
        ws.removeAllListeners("error");
        reject(
          res.statusCode === 426
            ? new PairingError(
                "This version of mtmux is too old to pair.",
                "Run: npm i -g mtmux@latest",
              )
            : new PairingError(
                `Pairing service returned ${res.statusCode ?? "no status"}.`,
              ),
        );
      });
      ws.once("error", reject);
      ws.once("open", () => {
        ws.removeAllListeners("error");
        resolve({
          send: (message) => ws.send(JSON.stringify(message)),
          onMessage: (cb) => ws.on("message", (raw) => cb(raw.toString())),
          onClose: (cb) => ws.on("close", cb),
          close: () => ws.close(),
        });
      });
    });
  }

  return {
    async postClaim(body) {
      const res = await fetch(`${apiBase}/v1/pair/claim`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // `v` is added here rather than by the caller so the exchange logic
        // never has to know the protocol version, and so a test transport is
        // not obliged to fake one.
        body: JSON.stringify({ ...(body as object), v: PROTOCOL_VERSION }),
      });
      if (res.status === 426) throw tooOld();
      if (res.status === 429) {
        throw new PairingError(
          "Too many pairing attempts from this network.",
          "Wait a minute and try again.",
        );
      }
      if (!res.ok) {
        throw new PairingError(`Pairing service returned ${res.status}.`);
      }
      // Parsed rather than cast: a broker answering with something else is a
      // clearer failure here than an undefined claim id three lines later.
      return PairClaimResponse.parse(await res.json());
    },

    async postMailbox(space) {
      // Retried, because the failure this used to produce was badly
      // disproportionate to its cause: at boot a single transient 503 dropped
      // the whole process to LAN-only for its lifetime, and on the re-arm path
      // it left the machine with no code and nothing on screen to say why.
      let last: PairingError | null = null;
      for (let attempt = 0; attempt < MAILBOX_POST_ATTEMPTS; attempt += 1) {
        const res = await fetch(`${apiBase}/v1/pair/new`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            v: PROTOCOL_VERSION,
            ...(space ? { space } : {}),
          }),
        });
        if (res.status === 426) throw tooOld();
        if (res.status === 429) {
          throw new PairingError(
            "Too many pairing codes requested from this network.",
            "Wait a minute and try again.",
          );
        }
        if (res.ok) return PairNewResponse.parse(await res.json());

        last = new PairingError(`Pairing service returned ${res.status}.`);
        // 503 means every slot draw collided — a full broker, not a broken
        // one, and the next draw is independent. Anything else is unlikely to
        // fix itself, so it is reported straight away.
        if (res.status !== 503) throw last;
        if (attempt < MAILBOX_POST_ATTEMPTS - 1) {
          await delay(retryAfterMs(res.headers.get("retry-after")));
        }
      }
      throw last ?? new PairingError("Pairing service is unavailable.");
    },

    openClaimSocket: (claimId) => openSocket(`/v1/claim/${claimId}`),
    openMailboxSocket: (mailboxId) => openSocket(`/v1/pair/${mailboxId}`),
  };
}
