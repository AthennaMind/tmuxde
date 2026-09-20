import {
  bytesToBase64Url,
  bytesToHex,
  confirmationTag,
  hexToBytes,
  verifyConfirmation,
  type SessionKeys,
} from "@repo/crypto";
import {
  tryDeserializePairingServerMessage,
  type PairPeerShareMessage,
  type SealedDescriptor,
} from "@repo/protocol";

/**
 * The CLI's half of a pairing exchange, once a socket to the broker is open.
 *
 * Both directions of hosted pairing land here. Either the CLI claimed a code
 * the browser is showing (`mtmux pair 492716`) or the CLI is showing one and
 * the browser claimed it (`mtmux start`). The cryptography is identical; what
 * differs is only which side already sent its CPace share and therefore who
 * speaks first. That difference is the `ExchangeSide` below, and it is the only
 * thing in this file that knows the two flows exist.
 *
 * ## Fan-out
 *
 * A slot is three digits and shared on purpose, so a claim reaches every
 * live mailbox holding it and several peers may answer. Each gets its own CPace
 * run and its own key schedule; whichever produces a confirmation tag that
 * verifies is the real one, and the rest are closed — which destroys their
 * mailboxes. `outstanding` counts the peers that could still turn out to be the
 * one, so the run can fail fast the moment the last candidate is ruled out
 * instead of sitting until the timeout. It is counted from the shares that
 * arrive rather than from a total the broker promises, because a broker that
 * reports live mailbox counts is handing out an enumeration oracle.
 *
 * ## The identity labels never swap
 *
 * `confirmationTag(key, "cli")` and `verifyConfirmation(key, "browser", …)` are
 * keyed to *who* each end is, not to which of them initiated. They stay put
 * when the direction inverts. Swapping them with the role would mean the two
 * ends verify each other's tags against different strings and every pairing
 * fails — silently, and only in one direction.
 */

/** Associated data the CLI binds into every CPace transcript it takes part in. */
export const AD_CLI = "cli";

/**
 * Belt-and-braces bound on the peer's associated data.
 *
 * The protocol schema already caps it at 256, so this only fires if that cap
 * ever loosens. It is cheap insurance on a value that goes straight into a
 * hash transcript.
 */
export const AD_PEER_MAX = 256;

/**
 * Why a run ended, for callers that must act differently rather than only say
 * something different. `expired` is the one that matters: it means nobody ever
 * engaged with the code, which is what separates an abandoned terminal from a
 * watched one.
 */
export type PairingErrorKind =
  | "expired"
  | "no-match"
  | "lost"
  | "too-many-peers"
  | "failed";

export class PairingError extends Error {
  constructor(
    message: string,
    readonly hint?: string,
    readonly kind: PairingErrorKind = "failed",
  ) {
    super(message);
    this.name = "PairingError";
  }
}

/** Minimal socket shape, so the exchange is testable without a real network. */
export type PairingSocket = {
  send(message: unknown): void;
  onMessage(cb: (raw: string) => void): void;
  onClose(cb: () => void): void;
  close(): void;
};

export type PairingResult = {
  keys: SessionKeys;
  /**
   * The browser's device identity, to persist for signed reconnects.
   *
   * Both are null today: the browser has no device key of its own yet, so the
   * only thing it contributes to the transcript is its associated data. They
   * are here because the peer list stores them, and a `null` that means "this
   * peer never presented one" is honest where an empty string is not.
   */
  peerDeviceId: string | null;
  peerPublicKey: string | null;
  peerLabel: string;
};

/** One in-flight CPace exchange with a single candidate peer. */
export type Attempt = {
  peer: string;
  /** This side's CPace share for this peer. */
  ownShare: Uint8Array;
  keys: SessionKeys;
  peerAd: string;
};

/** What `derive` produces: an attempt to keep, or a reason to give up. */
export type Derived = { attempt: Attempt } | { reject: string };

/**
 * Which socket the CLI is holding, which fixes who speaks first.
 *
 * - `"claim"` — the CLI claimed someone else's code. Its share travelled in the
 *   claim POST, so it has nothing to say until a peer answers, and it withholds
 *   its own confirmation tag until the peer's tag has verified.
 *
 * - `"mailbox"` — the CLI is showing the code. The claimant is blocked waiting
 *   on it, so on the first peer share it answers with its own share *and* its
 *   confirmation tag, before the peer has proved anything.
 *
 * Confirming first is safe and is the standard shape for CPace with mutual key
 * confirmation — someone has to go first. The tag is HMAC over a key derived
 * from the CPace ISK, and computing that ISK for any candidate secret needs the
 * mailbox holder's ephemeral scalar. A claimant who guessed wrong learns only
 * "that was not it", which is exactly what its own single guess would have told
 * it, and the failed exchange destroys the mailbox either way.
 */
export type ExchangeSide = "claim" | "mailbox";

export type ExchangeOptions = {
  socket: PairingSocket;
  side: ExchangeSide;
  /**
   * Most peers this run will entertain, or undefined for no bound.
   *
   * Set by a claimant to the broker's own per-slot cap: being offered more
   * mailboxes than the broker is supposed to keep on a slot is the signature
   * of a broker multiplying an attacker's guesses, so the run stops.
   *
   * A mailbox holder leaves it unset. Its offers lapse and it legitimately
   * returns to circulation, so it can see several claims across its lifetime.
   */
  maxPeers?: number;
  /** Override the straggler window. Tests drive this; callers rarely do. */
  noMatchGraceMs?: number;
  /** Derive this peer's key schedule from its share. */
  derive: (msg: PairPeerShareMessage) => Derived;
  /**
   * The last gate: a human says yes before the descriptor is sealed.
   *
   * Placed *here*, and not in the caller's `paired` handler, for a reason that
   * is not cosmetic. Once `pair:establish` goes out the browser believes it is
   * in: it races the direct candidates, opens a socket and sends `auth`, and
   * the relay's `auth:failure` is terminal — `ws-client.ts` marks it an
   * intentional close and never retries. Gating after the fact would therefore
   * strand the browser on a dead end for as long as the human took to decide,
   * and then leave it there. Gating before it means the browser simply stays
   * in "verifying" until the answer arrives, and a refusal reaches it as a
   * `pair:close` with a reason it can show.
   *
   * Returning false burns this peer and nothing else: the round re-arms with a
   * fresh code, and no key, token or peer record was ever written.
   */
  admit?: (peerLabel: string) => Promise<boolean>;
  /** Built once a key is known, so it can be sealed for that peer alone. */
  buildDescriptor: () => SealedDescriptor;
  seal: (
    keys: SessionKeys,
    descriptor: SealedDescriptor,
  ) => Promise<Uint8Array>;
  timeoutMs: number;
  /**
   * Wording for the ways a run ends badly. The two flows want to say
   * quite different things ("reload the page" vs "scan the new code"), and
   * error copy is the whole of what the user sees when pairing fails.
   */
  errors: {
    noMatch: () => PairingError;
    timedOut: () => PairingError;
    lost: () => PairingError;
    /** The broker offered more peers than its own cap allows. */
    tooManyPeers: () => PairingError;
    /** Wraps a failure the broker reported; see `describeFailure`. */
    failed: (reason: string) => PairingError;
  };
};

export type Exchange = {
  result: Promise<PairingResult>;
  /** Settle the run early — cancellation, or an expiry the caller is tracking. */
  abort(err: PairingError): void;
};

/**
 * How long to wait for a straggling peer before calling a code wrong.
 *
 * Long enough that a terminal on a slow link is not mistaken for a bad code,
 * short enough to beat the run's own timeout by an order of magnitude.
 */
const NO_MATCH_GRACE_MS = 3_000;

export function runExchange(opts: ExchangeOptions): Exchange {
  const { socket } = opts;
  const attempts = new Map<string, Attempt>();

  let settled = false;
  /**
   * Peers that could still turn out to be the one, counted from the shares
   * that actually arrive. The broker no longer reports how many mailboxes a
   * slot holds — that count was an enumeration oracle — so `seen` is what
   * separates "every peer was ruled out" from "none has answered yet". The
   * latter is the timeout's business.
   */
  let outstanding = 0;
  let seen = 0;
  /**
   * Armed when the last known candidate is ruled out.
   *
   * Peers answer independently over the network, so a decoy can be ruled out
   * before the real terminal has said anything at all — declaring "wrong code"
   * the instant the counter hits zero would fail correct codes on a slow link.
   * The grace window closes that race; a share arriving cancels it.
   */
  let graceTimer: ReturnType<typeof setTimeout> | null = null;
  let finish!: (err: Error | null, result?: PairingResult) => void;

  const result = new Promise<PairingResult>((resolve, reject) => {
    const timer = setTimeout(
      () => finish(opts.errors.timedOut()),
      opts.timeoutMs,
    );
    // A pending pairing must never be the reason a CLI refuses to exit.
    timer.unref?.();

    finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);
      socket.close();
      if (err) reject(err);
      else resolve(value!);
    };

    function send(message: unknown) {
      socket.send(message);
    }

    /** This peer cannot be the one. */
    function ruleOut(peer: string) {
      attempts.delete(peer);
      outstanding -= 1;
      if (seen === 0 || outstanding > 0) return;

      // Every peer that has answered has been ruled out. If the broker's cap
      // is known and that many have answered, nothing else can be coming and
      // the run can fail immediately; otherwise wait a moment for stragglers.
      if (opts.maxPeers !== undefined && seen >= opts.maxPeers) {
        finish(opts.errors.noMatch());
        return;
      }
      if (graceTimer) return;
      graceTimer = setTimeout(
        () => finish(opts.errors.noMatch()),
        opts.noMatchGraceMs ?? NO_MATCH_GRACE_MS,
      );
      graceTimer.unref?.();
    }

    /**
     * Rule a peer out *and* tell the broker.
     *
     * The telling is the load-bearing part: `pair:close` destroys that peer's
     * mailbox, so a wrong six-digit guess costs the whole code rather than
     * one of ten thousand tries.
     */
    function giveUpOn(peer: string, reason: string) {
      send({ type: "pair:close", peer, reason });
      ruleOut(peer);
    }

    function sendOwnConfirm(attempt: Attempt) {
      send({
        type: "pair:confirm",
        peer: attempt.peer,
        tag: bytesToHex(confirmationTag(attempt.keys.confirm, "cli")),
      });
    }

    function handlePeerShare(msg: PairPeerShareMessage) {
      if (attempts.has(msg.peer)) {
        // A second share for a conversation already under way. The broker
        // forwards whatever it is handed, so this is a confused client or one
        // hoping to restart the exchange under a fresh scalar; neither is a
        // reason to abandon the run already in progress for that peer.
        return;
      }

      // A straggler has arrived, so "everyone has been ruled out" was wrong.
      if (graceTimer) {
        clearTimeout(graceTimer);
        graceTimer = null;
      }

      seen += 1;
      if (opts.maxPeers !== undefined && seen > opts.maxPeers) {
        // More peers than the broker is allowed to keep on a slot. Racing them
        // would be handing an attacker extra tries at the code.
        finish(opts.errors.tooManyPeers());
        return;
      }
      outstanding += 1;

      const derived = opts.derive(msg);
      if ("reject" in derived) {
        giveUpOn(msg.peer, derived.reject);
        return;
      }
      const attempt = derived.attempt;
      attempts.set(attempt.peer, attempt);

      if (opts.side === "mailbox") {
        send({
          type: "pair:share",
          peer: attempt.peer,
          share: bytesToHex(attempt.ownShare),
          ad: AD_CLI,
        });
        sendOwnConfirm(attempt);
      }
    }

    async function handlePeerConfirm(peer: string, tag: string) {
      const attempt = attempts.get(peer);
      if (!attempt) return;

      // The moment of truth. A wrong six-digit guess produces a different key,
      // so this tag cannot verify.
      if (
        !verifyConfirmation(attempt.keys.confirm, "browser", hexToBytes(tag))
      ) {
        giveUpOn(peer, "confirmation failed");
        return;
      }

      if (opts.side === "claim") sendOwnConfirm(attempt);

      if (opts.admit) {
        const label = attempt.peerAd || "browser";
        let allowed = false;
        try {
          allowed = await opts.admit(label);
        } catch {
          // A gate that threw is not a yes. The only safe reading of "I could
          // not ask" is the same as the one for "nobody answered".
          allowed = false;
        }
        if (settled) return;
        if (!allowed) {
          giveUpOn(peer, "refused at the machine");
          return;
        }
      }

      try {
        const sealed = await opts.seal(attempt.keys, opts.buildDescriptor());
        if (settled) return;
        send({
          type: "pair:establish",
          peer,
          sealedDescriptor: bytesToBase64Url(sealed),
        });
        finish(null, {
          keys: attempt.keys,
          peerDeviceId: null,
          peerPublicKey: null,
          peerLabel: attempt.peerAd || "browser",
        });
      } catch (err) {
        finish(
          new PairingError(
            `Could not complete pairing: ${
              err instanceof Error ? err.message : String(err)
            }`,
          ),
        );
      }
    }

    socket.onClose(() => finish(opts.errors.lost()));

    socket.onMessage((raw) => {
      const parsed = tryDeserializePairingServerMessage(raw);
      // A frame the broker should never have sent is dropped rather than fatal.
      if (!parsed.ok) return;
      const msg = parsed.message;

      switch (msg.type) {
        case "pair:ready":
          // Only a mailbox holder receives this, and everything it carries —
          // mailbox id, slot, expiry — came back from POST /v1/pair/new before
          // this socket existed. It is an acknowledgement, not news.
          return;

        case "pair:failed":
          // A peer-scoped failure retires one conversation; only a failure with
          // no peer is about the socket itself and ends the run.
          if (msg.peer) ruleOut(msg.peer);
          else finish(opts.errors.failed(msg.reason));
          return;

        case "pair:peer-share":
          handlePeerShare(msg);
          return;

        case "pair:peer-confirm":
          void handlePeerConfirm(msg.peer, msg.tag);
          return;

        case "pair:established":
          // The CLI is always the end that produces the descriptor, so it never
          // receives one.
          return;
      }
    });
  });

  return {
    result,
    abort: (err) => finish(err),
  };
}

/** Broker failure reasons, in words. The caller supplies the "what now". */
export function describeFailure(reason: string): string {
  switch (reason) {
    case "expired":
      return "That code has expired.";
    case "already-claimed":
      return "That code has already been used.";
    case "confirmation-failed":
      return "The code did not match.";
    case "rate-limited":
      return "Too many attempts. Wait a minute and try again.";
    case "peer-gone":
      return "The other device stopped waiting for this code.";
    default:
      return "Pairing failed.";
  }
}
