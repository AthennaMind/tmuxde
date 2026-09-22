import WebSocket from "ws";
import {
  FrameOpener,
  FrameSealer,
  StreamOpener,
  base64UrlToBytes,
  bytesToBase64Url,
  bytesToHex,
  hexToBytes,
  signChallenge,
  utf8ToBytes,
  deriveSas,
  deriveSessionKeys,
  newEphemeralKey,
  sasSharedSecret,
  sasTranscript,
  verifySasCommitment,
  type DeviceKeyPair,
  type EphemeralKeyPair,
  type SessionKeys,
} from "@repo/crypto";
import {
  PROTOCOL_VERSION,
  tryDeserializeTunnelServerMessage,
  type PairDeniedMessage,
  type TunnelServerMessage,
} from "@repo/protocol";

/**
 * The reverse tunnel agent.
 *
 * Holds one outbound WebSocket to the broker. When the broker says a browser
 * wants a stream, the agent opens an ordinary local WebSocket to
 * `ws://127.0.0.1:<port>/_relay`, authenticates it with the local AUTH_TOKEN,
 * and copies relay protocol lines between the two — unsealing what comes from
 * the browser and sealing what goes back.
 *
 * The isolation is the point: the relay sees a perfectly normal authenticated
 * local client and knows nothing about tunnels, brokers, pairing or AES. No
 * relay internals are touched, so nothing here can regress the self-hosted
 * path. It also means the 64-hex AUTH_TOKEN is injected on this side of the
 * tunnel and never travels over it.
 *
 * ## Why the crypto lives here
 *
 * The browser seals every relay line under the pairing keys, so the wire
 * carries AES-GCM ciphertext and the broker is a blind forwarder. Something has
 * to be the other end of that seal, and it cannot be the relay — teaching the
 * relay about pairing keys would put the tunnel on the self-hosted path's
 * critical code. So the agent is the cryptographic peer: ciphertext in from the
 * broker, plaintext JSON out to loopback, and the reverse coming back.
 *
 * ## Why streams are matched to keys by trial decryption
 *
 * One agent serves every browser paired with this machine, each with its own
 * key schedule, all multiplexed over one tunnel. The broker tells us a stream
 * opened but deliberately knows nothing about which pairing it belongs to —
 * making it say would hand it exactly the mapping the design denies it. So the
 * first frame decides: whichever key schedule authenticates it owns the stream.
 * AES-GCM's tag is precisely the right discriminator, the keyring is small, and
 * a stream no key opens is refused rather than forwarded. That is also what
 * stops an unpaired browser that guessed a tunnel id from reaching the relay.
 */

export type LocalSocket = {
  send(data: string): void;
  close(): void;
  onMessage(cb: (data: string) => void): void;
  onClose(cb: () => void): void;
  onOpen(cb: () => void): void;
};

/**
 * The broker socket, which needs liveness the loopback one does not.
 *
 * All three are optional so a plain `LocalSocket` still satisfies the type —
 * the keepalive degrades to "no keepalive" for any transport that cannot do
 * it, rather than forcing every fake in every test to grow three methods.
 */
export type AgentSocket = LocalSocket & {
  /** Send a protocol-level ping frame. */
  ping?(): void;
  /** Any evidence the far end is alive — a pong, or a ping it sent us. */
  onPong?(cb: () => void): void;
  /**
   * Kill the socket now, without waiting for a close handshake.
   *
   * The case this exists for is a half-open connection: the peer is gone but
   * no FIN ever arrived, so `readyState` is still OPEN and a graceful
   * `close()` waits for a reply that will never come.
   */
  terminate?(): void;
  /**
   * The server refused the handshake with an HTTP status.
   *
   * Exists for one status: 426. Without it the agent's `ws.on("error")`
   * swallowed the response and turned "your mtmux is too old" into an
   * indistinguishable connect failure, so the CLI retried forever against a
   * broker that would never accept it, and the user saw a tunnel that simply
   * never came up.
   */
  onUnsupported?(cb: (status: number) => void): void;
};

export type TunnelAgentOptions = {
  apiBase: string;
  deviceKey: DeviceKeyPair;
  /** Opens the persistent socket to the broker. */
  connectBroker: (url: string) => AgentSocket;
  /** Opens a local relay socket for one stream. */
  connectLocal: () => LocalSocket;
  onTunnelReady?: (tunnelId: string) => void;
  onStatus?: (status: AgentStatus, detail?: string) => void;
  /**
   * Decide a request from a signed-in browser to pair with this machine.
   *
   * Absent means refuse, which is the safe default: a machine with nobody to
   * ask must not let anyone in on the strength of an account session alone.
   * The SAS is already derived when this is called — the implementation's job
   * is to show it to a human and report what they said, and to seal the
   * descriptor if they said yes.
   */
  onAccessRequest?: (request: AccessRequest) => Promise<AccessDecision>;
  /**
   * A stream just bound to a pairing by trial decryption.
   *
   * Fires once per stream, on the first frame that authenticates, with whoever
   * owns the winning key schedule — undefined when the pairing predates peer
   * identities. This is the only moment the agent knows *which* device is on
   * the other end of a tunnel the broker is deliberately blind to, so it is
   * where anything device-aware has to hang.
   */
  onStreamBound?: (peer?: PeerIdentity) => void;
  /**
   * Decide whether a bound stream may reach the relay at all.
   *
   * Runs after trial decryption has established *which* pairing this is and
   * before anything is forwarded, which is the only point where both facts are
   * available. Absent means admit everything, which is the default and what
   * every release before the reconnect policy did.
   */
  admitStream?: (peer?: PeerIdentity) => Promise<boolean>;
  /** Injected for tests; real runs use exponential backoff with jitter. */
  scheduleRetry?: (attempt: number, run: () => void) => void;
  /**
   * Liveness on the broker socket. Injected for tests; the defaults are wall
   * clock and `setInterval`.
   */
  keepalive?: {
    intervalMs?: number;
    deadlineMs?: number;
    now?: () => number;
    /** Starts a repeating timer and returns its canceller. */
    schedule?: (intervalMs: number, tick: () => void) => () => void;
  };
};

export type AgentStatus =
  | "connecting"
  | "registered"
  | "disconnected"
  /**
   * The broker refuses this build's protocol. Terminal: retrying cannot fix
   * it, and continuing to retry hides the one thing the user can act on.
   */
  | "outdated"
  | "stopped";

/** What the human at this machine is being asked to approve. */
export type AccessRequest = {
  requestId: string;
  /** Six digits, to be compared against what the browser is showing. */
  sas: string;
  /** Self-reported by the browser. Shown, never trusted. */
  deviceLabel: string;
  accountEmail: string;
  /** Already derived, so the caller only has to seal with them. */
  keys: SessionKeys;
};

export type AccessDecision =
  | { approved: true; sealedDescriptor: string }
  | { approved: false; reason?: "refused" | "no-tty" | "timeout" };

const BASE_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30_000;

/**
 * How often to prove the broker socket is still there, and how long silence is
 * allowed to last before we stop believing it.
 *
 * The broker runs the mirror image of this (`apps/api/src/server.ts`), and for
 * a while that was the only liveness check on this connection — which is a
 * one-way guarantee. It tells the broker to drop an agent that has gone away;
 * it tells the agent nothing. On a half-open socket — a laptop suspended and
 * resumed, a NAT that dropped the mapping, a Wi-Fi handover — no FIN arrives,
 * `readyState` stays OPEN, `onClose` never fires, and the retry loop below
 * never arms. The agent then sits there believing it is registered while the
 * tunnel id it is advertising routes nowhere, and the only cure is restarting
 * the CLI. That is the second half of the "I have to restart it every day"
 * report, and this is what closes it.
 *
 * The deadline is two and a half intervals: one missed round is a hiccup, two
 * is a dead link, and reconnecting costs a second of backoff.
 */
const KEEPALIVE_MS = 30_000;
const KEEPALIVE_DEADLINE_MS = 75_000;

function defaultSchedule(intervalMs: number, tick: () => void): () => void {
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

/**
 * How many pairings one agent will try a frame against.
 *
 * Bounds the cost of trial decryption and, with it, the work an unpaired caller
 * can make us do by opening streams. Oldest entries are evicted first.
 *
 * Raised from 8 once the keyring started being restored from disk at startup.
 * Eight is under what a household reaches — two people with a phone, a tablet
 * and a laptop each is six, and every browser profile counts separately — and
 * an evicted entry is not a slow path, it is a device that silently cannot
 * reconnect. That is the exact bug the restore exists to fix, so a cap low
 * enough to reintroduce it for the ninth device is the wrong cap. The cost of
 * the higher number is bounded and small: a failed trial is one AES-GCM tag
 * check, paid only on a stream's first frame.
 */
const MAX_KEYRING = 64;

/** Mirrors apps/web/src/lib/ws-client.ts so reconnect behaviour is familiar. */
function defaultRetry(attempt: number, run: () => void): void {
  const capped = Math.min(BASE_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS);
  // Jitter: a fleet of agents reconnecting after a broker restart must not
  // arrive in lockstep.
  const delay = capped / 2 + Math.random() * (capped / 2);
  setTimeout(run, delay).unref?.();
}

export type TunnelAgent = {
  start(): void;
  stop(): void;
  /**
   * Admit a completed pairing's keys, so streams sealed under them can be
   * opened. Called once `mtmux pair` finishes its PAKE.
   */
  addSessionKeys(keys: SessionKeys, peer?: PeerIdentity): void;
  /**
   * Forget a device's keys, and drop whatever it has open.
   *
   * Revoking the relay's session token already stops that device
   * authenticating, so this is not what keeps it out. It is what stops it
   * *reaching* loopback at all: without it a removed browser can still open
   * a sealed stream, be bound by trial decryption and be refused one frame
   * later, which is a working tunnel to a closed door. Returns how many
   * entries went, so the caller can say nothing when there was nothing.
   */
  removeSessionKeys(deviceId: string): number;
  readonly tunnelId: string | null;
  readonly status: AgentStatus;
};

/**
 * Who a key schedule belongs to, when we happen to know.
 *
 * Optional because a pairing completing right now knows the browser's
 * self-reported label but not much else, while one restored from disk carries
 * the record `mtmux devices` prints. Naming the peer is what lets the CLI say
 * "iPhone · Safari reconnected" rather than "a device", and what a reconnect
 * approval prompt has to show a human before it can mean anything.
 */
export type PeerIdentity = {
  deviceId: string;
  label: string;
  /** True when this came from disk rather than a pairing in this process. */
  restored: boolean;
};

export type KeyringEntry = {
  keys: SessionKeys;
  peer?: PeerIdentity;
};

/** A requested pairing between the ack and the reveal. */
type PendingAccess = {
  commitment: Uint8Array;
  deviceLabel: string;
  accountEmail: string;
  ephemeral: EphemeralKeyPair;
};

/** Everything one browser↔relay stream needs. */
type Stream = {
  local: LocalSocket;
  /** Bound on the first frame that authenticates. */
  opener: FrameOpener | null;
  sealer: FrameSealer | null;
  /** Which pairing won the trial decryption, once one has. */
  peer?: PeerIdentity;
  /**
   * Serializes the async seal/open calls. WebCrypto is promise-based, and the
   * relay protocol is order-sensitive, so frames must not be allowed to
   * overtake one another between the two sockets.
   */
  chain: Promise<void>;
  localOpen: boolean;
  /** Plaintext lines unsealed before the loopback socket finished opening. */
  toLocal: string[];
  /** Relay lines produced before the browser's first frame bound a sealer. */
  toBroker: string[];
  closed: boolean;
};

export function createTunnelAgent(opts: TunnelAgentOptions): TunnelAgent {
  const retry = opts.scheduleRetry ?? defaultRetry;
  let broker: AgentSocket | null = null;
  let tunnelId: string | null = null;
  let status: AgentStatus = "disconnected";
  let attempt = 0;
  let stopped = false;

  const keepaliveIntervalMs = opts.keepalive?.intervalMs ?? KEEPALIVE_MS;
  const keepaliveDeadlineMs =
    opts.keepalive?.deadlineMs ?? KEEPALIVE_DEADLINE_MS;
  const clock = opts.keepalive?.now ?? Date.now;
  const schedule = opts.keepalive?.schedule ?? defaultSchedule;
  let cancelKeepalive: (() => void) | null = null;
  let lastInboundAt = 0;

  function stopKeepalive(): void {
    cancelKeepalive?.();
    cancelKeepalive = null;
  }

  /**
   * Watch one broker socket, and give up on it once it stops answering.
   *
   * Anything inbound counts as proof of life, not just pongs — a frame that
   * arrived is a link that works, and the broker's own keepalive pings are
   * evidence too. Terminating rather than closing is the point: the socket
   * this fires on is one a graceful close would wait on forever.
   */
  function startKeepalive(socket: AgentSocket): void {
    stopKeepalive();
    lastInboundAt = clock();
    socket.onPong?.(() => {
      lastInboundAt = clock();
    });
    cancelKeepalive = schedule(keepaliveIntervalMs, () => {
      // This runs on a bare interval. An exception escaping it is an unhandled
      // throw in a timer callback, which takes the whole CLI down — and the
      // rule for this file is that the tunnel is a best-effort fallback that
      // must never do that.
      try {
        // A timer that outlived its socket must not kill the current one.
        if (broker !== socket) {
          stopKeepalive();
          return;
        }
        if (clock() - lastInboundAt > keepaliveDeadlineMs) {
          stopKeepalive();
          if (socket.terminate) socket.terminate();
          else socket.close();
          return;
        }
        socket.ping?.();
      } catch {
        // A socket that throws on `ping` is one that is already going away;
        // its close event is what recovers, and it is on its way.
      }
    });
  }

  const streams = new Map<string, Stream>();
  /**
   * Requests waiting for the browser to reveal the key it committed to.
   *
   * Holds the commitment and our own ephemeral key, and nothing else — the
   * derived keys do not exist until the reveal arrives, so a request abandoned
   * halfway leaves no key material behind.
   */
  const accessRequests = new Map<string, PendingAccess>();
  /**
   * Key schedules this agent will try an unbound stream's first frame against.
   *
   * Two sources, and the second is the whole point: pairings completed in this
   * process, and pairings restored from `~/.mtmux/config.json` at startup. It
   * used to be the first alone — "every pairing *this process* has completed" —
   * which meant a restart silently revoked every device on the tunnel path.
   */
  const keyring: KeyringEntry[] = [];

  function setStatus(next: AgentStatus, detail?: string) {
    status = next;
    opts.onStatus?.(next, detail);
  }

  function send(message: unknown) {
    broker?.send(JSON.stringify(message));
  }

  function dropStream(streamId: string, reason: string, tellBroker = true) {
    const stream = streams.get(streamId);
    if (!stream || stream.closed) return;
    stream.closed = true;
    streams.delete(streamId);
    stream.local.close();
    if (tellBroker) send({ type: "stream:close", streamId, reason });
  }

  function teardownStreams() {
    for (const streamId of [...streams.keys()]) {
      dropStream(streamId, "agent shutting down", false);
    }
    streams.clear();
  }

  function writeLocal(stream: Stream, line: string) {
    if (stream.localOpen) stream.local.send(line);
    else stream.toLocal.push(line);
  }

  /** Seal one relay line and hand it to the broker. */
  async function sealToBroker(streamId: string, stream: Stream, line: string) {
    if (!stream.sealer) {
      // The relay answered our own `auth` before the browser's first frame
      // arrived, so we do not yet know which key to seal under. Hold it.
      stream.toBroker.push(line);
      return;
    }
    const sealed = await stream.sealer.seal(utf8ToBytes(line));
    if (stream.closed) return;
    send({
      type: "stream:frame",
      streamId,
      data: bytesToBase64Url(sealed),
    });
  }

  /**
   * Unseal one browser frame and write the relay line inside it to loopback.
   *
   * The first frame on a stream also picks the key schedule; see the note at
   * the top of this file.
   */
  async function openFromBroker(
    streamId: string,
    stream: Stream,
    data: string,
  ) {
    let bytes: Uint8Array;
    try {
      bytes = base64UrlToBytes(data);
    } catch {
      dropStream(streamId, "malformed frame");
      return;
    }

    if (!stream.opener) {
      for (const entry of keyring) {
        // Trial decryption, one keyring entry at a time. `bind` reads the
        // salt off the frame and derives that connection's subkey before it
        // attempts anything, and reports every failure identically, so the
        // loop cannot tell "not this pairing" from "malformed" — which is
        // what lets it run against bytes a hostile broker chose.
        let bound: { opener: FrameOpener; plaintext: Uint8Array };
        try {
          bound = await StreamOpener.bind(entry.keys.c2s, "c2s", bytes);
        } catch {
          continue;
        }
        const line = new TextDecoder().decode(bound.plaintext);
        if (stream.closed) return;
        stream.opener = bound.opener;
        // Our own salt is drawn here and rides our first reply. The browser
        // always speaks first, and `sealToBroker` holds outbound lines until
        // this exists, so no round trip is needed to agree on it.
        stream.sealer = new FrameSealer(entry.keys.s2c, "s2c");
        stream.peer = entry.peer;

        // The gate sits here, after the key has proved who this is and before
        // a single byte reaches the relay. Awaiting is safe: frames for one
        // stream are serialised through `stream.chain`, so anything that
        // arrives while a human is being asked queues behind the answer
        // instead of racing past it.
        if (opts.admitStream && !(await opts.admitStream(entry.peer))) {
          if (!stream.closed) dropStream(streamId, "not approved");
          return;
        }
        if (stream.closed) return;

        opts.onStreamBound?.(entry.peer);
        writeLocal(stream, line);
        // Flush anything the relay said while we did not know the key.
        for (const held of stream.toBroker.splice(0)) {
          await sealToBroker(streamId, stream, held);
        }
        return;
      }
      // No pairing this process knows about can open it. Refuse rather than
      // forward: this is the check that keeps a guessed tunnel id worthless.
      dropStream(streamId, "no matching pairing");
      return;
    }

    try {
      const line = new TextDecoder().decode(await stream.opener.open(bytes));
      if (!stream.closed) writeLocal(stream, line);
    } catch {
      // Tampered, replayed or reordered. There is no safe way to continue on a
      // stream whose integrity has failed.
      dropStream(streamId, "frame authentication failed");
    }
  }

  function openStream(streamId: string) {
    const local = opts.connectLocal();
    const stream: Stream = {
      local,
      opener: null,
      sealer: null,
      chain: Promise.resolve(),
      localOpen: false,
      toLocal: [],
      toBroker: [],
      closed: false,
    };
    streams.set(streamId, stream);

    local.onOpen(() => {
      stream.localOpen = true;
      for (const line of stream.toLocal.splice(0)) local.send(line);
    });

    local.onMessage((line) => {
      stream.chain = stream.chain
        .then(() => sealToBroker(streamId, stream, line))
        .catch(() => dropStream(streamId, "seal failed"));
    });

    local.onClose(() => {
      if (!stream.closed) dropStream(streamId, "local closed");
    });
  }

  function handle(message: TunnelServerMessage) {
    switch (message.type) {
      case "tunnel:challenge": {
        const challenge = hexToBytes(message.challenge);
        send({
          type: "tunnel:register",
          deviceId: opts.deviceKey.deviceId,
          publicKey: bytesToHex(opts.deviceKey.publicKey),
          challenge: message.challenge,
          signature: bytesToHex(
            signChallenge(opts.deviceKey.secretKey, challenge),
          ),
        });
        return;
      }

      case "tunnel:ready": {
        tunnelId = message.tunnelId;
        attempt = 0;
        setStatus("registered");
        opts.onTunnelReady?.(message.tunnelId);
        return;
      }

      case "stream:open": {
        openStream(message.streamId);
        return;
      }

      case "stream:frame": {
        const stream = streams.get(message.streamId);
        if (!stream || stream.closed) return;
        stream.chain = stream.chain
          .then(() => openFromBroker(message.streamId, stream, message.data))
          .catch(() => dropStream(message.streamId, "open failed"));
        return;
      }

      case "stream:close": {
        dropStream(message.streamId, "browser closed", false);
        return;
      }

      case "pair:request": {
        // Answer with our ephemeral key straight away, having seen nothing of
        // theirs. That ordering is the whole point: the browser committed to
        // its key before this, so neither side — and crucially not the broker
        // in between — can choose a key after seeing the other's.
        const ephemeral = newEphemeralKey();
        accessRequests.set(message.requestId, {
          commitment: hexToBytes(message.commitment),
          deviceLabel: message.deviceLabel,
          accountEmail: message.accountEmail,
          ephemeral,
        });
        send({
          type: "pair:request-ack",
          requestId: message.requestId,
          cliPublicKey: bytesToHex(ephemeral.publicKey),
        });
        return;
      }

      case "pair:reveal": {
        const pending = accessRequests.get(message.requestId);
        if (!pending) return;
        // One shot per request, whatever happens next.
        accessRequests.delete(message.requestId);
        void decideAccess(message.requestId, pending, message.browserPublicKey);
        return;
      }

      case "tunnel:closed": {
        setStatus("disconnected", message.reason);
        teardownStreams();
        broker?.close();
        return;
      }
    }
  }

  /**
   * Check the commitment, derive the SAS, and ask.
   *
   * A refusal and a failed commitment are reported differently on the wire but
   * both end the request — the broker burns it either way, so neither can be
   * retried without the browser starting over.
   */
  async function decideAccess(
    requestId: string,
    pending: PendingAccess,
    browserPublicKeyHex: string,
  ): Promise<void> {
    const deny = (reason: PairDeniedMessage["reason"]) =>
      send({ type: "pair:denied", requestId, reason });

    let keys: SessionKeys;
    let sas: string;
    try {
      const browserPublicKey = hexToBytes(browserPublicKeyHex);
      // The revealed key must be the one that was committed to. A broker
      // splicing in its own key fails here rather than silently succeeding.
      if (
        !verifySasCommitment(pending.commitment, browserPublicKey, requestId)
      ) {
        deny("commitment-failed");
        return;
      }

      const ikm = sasSharedSecret(pending.ephemeral.secret, browserPublicKey);
      const transcript = sasTranscript(
        requestId,
        pending.commitment,
        browserPublicKey,
        pending.ephemeral.publicKey,
      );
      keys = deriveSessionKeys(ikm, transcript);
      sas = deriveSas(ikm, transcript);
    } catch {
      // A malformed or degenerate key. Nothing to show a human.
      deny("commitment-failed");
      return;
    }

    // No handler means nobody can be asked, and nobody being asked means no.
    if (!opts.onAccessRequest) {
      deny("no-tty");
      return;
    }

    try {
      const decision = await opts.onAccessRequest({
        requestId,
        sas,
        deviceLabel: pending.deviceLabel,
        accountEmail: pending.accountEmail,
        keys,
      });
      if (!decision.approved) {
        deny(decision.reason ?? "refused");
        return;
      }
      send({
        type: "pair:approved",
        requestId,
        sealedDescriptor: decision.sealedDescriptor,
      });
    } catch {
      deny("refused");
    }
  }

  function connect() {
    if (stopped) return;
    setStatus("connecting");
    const socket = opts.connectBroker(
      // The agent socket carries the version floor too, and this is the piece
      // that is easiest to miss: the tunnel itself has no handshake, so a CLI
      // left online here would keep serving a tunnel whose frames no current
      // browser can open — an opaque "no matching pairing" for everyone.
      `${opts.apiBase.replace(/^http/, "ws")}/v1/agent?v=${PROTOCOL_VERSION}`,
    );
    broker = socket;
    startKeepalive(socket);

    socket.onUnsupported?.((status) => {
      if (status !== 426) return;
      stopped = true;
      stopKeepalive();
      setStatus(
        "outdated",
        "This version of mtmux is too old for the pairing service. Run: npm i -g mtmux@latest",
      );
    });

    socket.onMessage((raw) => {
      lastInboundAt = clock();
      const parsed = tryDeserializeTunnelServerMessage(raw);
      // A frame the broker should never have sent is dropped, not fatal: the
      // tunnel is a best-effort fallback and must not take the CLI down.
      if (parsed.ok) handle(parsed.message);
    });

    socket.onClose(() => {
      // A close event from a socket we have already replaced must not touch the
      // live one — the same guard the keepalive tick makes, and for the same
      // reason. A `stop()` followed by `start()` delivers the old socket's
      // close after the new one is up, and without this it cancelled the new
      // socket's keepalive and nulled `broker` underneath it, leaving the
      // connection alive with no half-open detection at all.
      if (broker !== socket) return;
      stopKeepalive();
      broker = null;
      tunnelId = null;
      teardownStreams();
      if (stopped) {
        // `outdated` is terminal and already reported; do not overwrite it
        // with a status that reads as "retrying".
        if (status !== "outdated") setStatus("stopped");
        return;
      }
      setStatus("disconnected");
      retry(attempt++, connect);
    });
  }

  return {
    start() {
      stopped = false;
      attempt = 0;
      connect();
    },
    stop() {
      stopped = true;
      stopKeepalive();
      teardownStreams();
      broker?.close();
      broker = null;
      setStatus("stopped");
    },
    addSessionKeys(keys, peer) {
      keyring.push({ keys, peer });
      if (keyring.length > MAX_KEYRING) keyring.shift();
    },
    removeSessionKeys(deviceId) {
      let removed = 0;
      for (let i = keyring.length - 1; i >= 0; i--) {
        if (keyring[i]?.peer?.deviceId !== deviceId) continue;
        keyring.splice(i, 1);
        removed += 1;
      }
      // The keys are gone, but a stream already bound under them is still
      // pumping bytes. Closing it here is the difference between "cannot come
      // back" and "is gone".
      for (const [streamId, stream] of [...streams]) {
        if (stream.peer?.deviceId === deviceId) dropStream(streamId, "revoked");
      }
      return removed;
    },
    get tunnelId() {
      return tunnelId;
    },
    get status() {
      return status;
    },
  };
}

/**
 * Real local relay socket: a plain WebSocket to loopback, carrying the
 * browser's own frames and nothing else.
 *
 * ## What was deleted here, and why that is the fix
 *
 * This used to authenticate the loopback socket with the machine's full
 * `AUTH_TOKEN` before any tunnel traffic flowed. Combined with the relay
 * blanket-acknowledging the browser's own `auth` frame — which arrived second,
 * on an already-privileged connection — the effect was that **over the tunnel
 * there was nothing to scope**: every tunnelled browser had the machine's god
 * token, whatever credential it presented.
 *
 * So the fix is a deletion. No token is injected; the browser's first sealed
 * frame is already `{type:"auth", token}`, and it now reaches the relay as the
 * first message on the socket and is authenticated on its own merits.
 *
 * **No defence is lost.** Trial decryption in `bindStream` already proves the
 * far end possesses a pairing key before a single byte is written to loopback,
 * so an unauthenticated stranger never reaches this socket at all. What
 * changes is only that the relay now learns *which* pairing it is talking to,
 * which is the entire prerequisite for a scoped share.
 */
export function localRelayConnector(port: number): () => LocalSocket {
  return () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/_relay`, {
      headers: {
        Origin: `http://127.0.0.1:${port}`,
        "User-Agent": "mtmux-tunnel-agent",
      },
    });
    const openHandlers: (() => void)[] = [];

    ws.on("open", () => {
      for (const cb of openHandlers) cb();
    });
    // A failed connect surfaces as a close, which tears the stream down.
    ws.on("error", () => ws.close());

    return {
      send: (data) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(data);
      },
      close: () => ws.close(),
      onMessage: (cb) => ws.on("message", (raw) => cb(raw.toString())),
      onClose: (cb) => ws.on("close", cb),
      onOpen: (cb) => {
        if (ws.readyState === WebSocket.OPEN) cb();
        else openHandlers.push(cb);
      },
    };
  };
}

/** Real broker socket. */
export function brokerConnector(): (url: string) => AgentSocket {
  return (url) => {
    const ws = new WebSocket(url);
    const openHandlers: (() => void)[] = [];
    ws.on("open", () => {
      for (const cb of openHandlers) cb();
    });
    // A failed connect surfaces as a close, which drives the retry loop.
    ws.on("error", () => ws.close());
    const unsupported: ((status: number) => void)[] = [];
    // Registered before any consumer asks, because `unexpected-response` fires
    // during the handshake and `ws.on("error")` above would otherwise close the
    // socket and lose the status with it.
    ws.on("unexpected-response", (_req, res) => {
      for (const cb of unsupported) cb(res.statusCode ?? 0);
      ws.close();
    });
    return {
      send: (data) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(data);
      },
      close: () => ws.close(),
      onMessage: (cb) => ws.on("message", (raw) => cb(raw.toString())),
      onClose: (cb) => ws.on("close", cb),
      onOpen: (cb) => {
        if (ws.readyState === WebSocket.OPEN) cb();
        else openHandlers.push(cb);
      },
      ping: () => {
        if (ws.readyState === WebSocket.OPEN) ws.ping();
      },
      // The broker pings us too, and `ws` answers those itself — but the ping
      // arriving is just as good a proof of life as the pong we send back, so
      // both count.
      onPong: (cb) => {
        ws.on("pong", cb);
        ws.on("ping", cb);
      },
      terminate: () => ws.terminate(),
      onUnsupported: (cb) => unsupported.push(cb),
    };
  };
}
