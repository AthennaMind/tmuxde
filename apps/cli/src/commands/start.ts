import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import kleur from "kleur";
import openBrowser from "open";
import * as configStore from "../config-store.js";
import * as grantsStore from "../grants-store.js";
import * as serverState from "../server-state.js";
import { banner, renderBannerLines, type PairingInvite } from "../banner.js";
import { primaryLanAddress, type LanAddress } from "../lan.js";
import { checkTmux, checkNode } from "../preflight.js";
import { serve, type RelayRuntime } from "../serve.js";
import { resolveApiBase } from "../api.js";
import { describeUpdate, fetchBrokerVersion } from "../update-check.js";
import { LOG_PATH, followLog, rotateIfNeeded } from "../log-file.js";
import { formatLogLine } from "./logs.js";
import {
  createTunnelAgent,
  brokerConnector,
  localRelayConnector,
  type PeerIdentity,
  type TunnelAgent,
} from "../tunnel-agent.js";
import {
  bytesToBase64Url,
  decodeSessionKeys,
  encodeSessionKeys,
  formatSas,
  generateLongSecret,
  generateSecret,
  type SessionKeys,
} from "@repo/crypto";
import {
  hostPairing,
  PairingError,
  type HostedPairing,
  type PairingErrorKind,
} from "../pairing-client.js";
import {
  buildCandidates,
  deviceLabel,
  registerDirectToken,
  sealDescriptor,
} from "./pair.js";
import * as account from "../account.js";
import { resolveShareSessions, shareBanner } from "../share-grants.js";
import { decideAccess, promptForReturningDevice } from "../access-prompt.js";
import {
  createApproveControl,
  type ApproveControl,
} from "../approve-control.js";
import { createDevicesControl } from "../devices-control.js";
import { createRecordControl } from "../record-control.js";
import type { GrantFiles, GrantRecord, GrantSession } from "@repo/protocol";
import { displayLabel } from "@repo/protocol";

// The whole CLI is bundled into dist/bin.js, so this module's own directory IS
// dist/ at runtime — not dist/commands/, which is where tsc used to put it.
// The published layout puts the web standalone server at
// dist/web/apps/web/server.js and the relay bundle at dist/relay/runtime.js.
// See apps/cli/scripts/build.mjs.
const DIST_DIR = path.dirname(fileURLToPath(import.meta.url));

const WEB_DIR = path.resolve(DIST_DIR, "web/apps/web");
const RELAY_RUNTIME = path.resolve(DIST_DIR, "relay/runtime.js");

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);
const WILDCARD = new Set(["0.0.0.0", "::"]);

/** The QR code outlives the terminal scrollback; keep the nonce alive as long. */
const PAIRING_NONCE_TTL_MS = 24 * 60 * 60 * 1000;

/** How often a signed-in server tells the registry it is still here. */
const HEARTBEAT_MS = 30_000;

/** Long enough for a slow link, short enough that nobody stares at a blank screen. */
const TUNNEL_READY_TIMEOUT_MS = 15_000;

/**
 * How many times each kind of failure may mint another code.
 *
 * The rule this replaces was "anything but a silent expiry resets the budget",
 * on the reasoning that a wrong code proves somebody is at the other end. An
 * attacker is also somebody. Sweeping the slot space forces a fresh code out of
 * every live pairing and collects one guess per sweep, forever — which turns a
 * bound that is supposed to be one guess per code into an unbounded online
 * search, and no amount of extra digits fixes an unbounded search. So each
 * failure mode now spends from its own budget and **only a completed pairing
 * resets anything**.
 *
 * - `expiries` — nobody ever touched the code. Five is roughly fifteen minutes
 *   of an unwatched terminal: long enough to cover a coffee, short enough that
 *   a machine left running for a week is not quietly issuing thousands of
 *   independent draws at the secret.
 * - `wrong` — someone claimed the code and failed key confirmation. Eight, with
 *   the backoff below, is generous for a human and ruinous for a sweep.
 * - `lost` — the socket dropped. Not a guess at all; the budget is a spin-loop
 *   guard so a broker outage cannot become a reconnect storm.
 */
export type RearmLimits = {
  expiries?: number;
  wrong?: number;
  lost?: number;
};

export const REARM_LIMITS: Required<RearmLimits> = {
  expiries: 5,
  wrong: 8,
  lost: 20,
};

/**
 * Delay before the code that follows the nth wrong one.
 *
 * The first three are free, because three fumbles in a row is what a real typo
 * looks like on a phone and charging for it would make the tool feel broken.
 * From the fourth the likelier reading is a stranger, and the delay is the
 * whole defence: it is what stops a sweep collecting guesses at line rate.
 */
const WRONG_BACKOFF_MS = [0, 0, 0, 5_000, 15_000, 45_000, 120_000, 120_000];

/** The wrong-code count from which the warning stops sounding like a typo. */
const GUESSING_AT = 4;

/** Consecutive failures of each kind, since the last completed pairing. */
export type RearmState = { expiries: number; wrong: number; lost: number };

/** A fresh budget. Handed out at boot and after every successful pairing. */
export const NO_FAILURES: RearmState = { expiries: 0, wrong: 0, lost: 0 };

export type RearmWarning = "wrong-code" | "guessing" | "broker-misbehaving";

export type RearmDecision = {
  rearm: boolean;
  state: RearmState;
  /** How long to wait before arming again. */
  delayMs: number;
  /** Something the human should be told, or null for the quiet path. */
  warn: RearmWarning | null;
};

/**
 * Anything that is not a `PairingError` came from the transport rather than
 * from the protocol — a fetch that threw, a socket that refused to open.
 * Counting it as `lost` keeps it bounded and backed off. Counting it as
 * engagement, which is what the old code did, is exactly the unbounded loop
 * this function exists to close.
 */
function failureKind(err: unknown): PairingErrorKind {
  return err instanceof PairingError ? err.kind : "lost";
}

/** Whether to mint another code after a failure, and what it costs. */
export function rearmDecision(
  err: unknown,
  state: RearmState,
  limits: RearmLimits & { jitter?: () => number } = {},
): RearmDecision {
  const max = { ...REARM_LIMITS, ...limits };
  const jitter = limits.jitter ?? Math.random;

  switch (failureKind(err)) {
    case "expired": {
      const expiries = state.expiries + 1;
      return {
        rearm: expiries < max.expiries,
        state: { ...state, expiries },
        delayMs: 0,
        warn: null,
      };
    }

    // A `failed` is a broker-reported `pair:failed`, which since the burn fix
    // also covers "a claim attached and then vanished". Both mean the code was
    // spent by somebody who could not confirm, so both cost the same.
    case "no-match":
    case "failed": {
      const wrong = state.wrong + 1;
      return {
        rearm: wrong < max.wrong,
        state: { ...state, wrong },
        delayMs:
          WRONG_BACKOFF_MS[wrong - 1] ??
          WRONG_BACKOFF_MS[WRONG_BACKOFF_MS.length - 1]!,
        warn: wrong >= GUESSING_AT ? "guessing" : "wrong-code",
      };
    }

    case "lost": {
      const lost = state.lost + 1;
      const ceiling = Math.min(1_000 * 2 ** lost, 30_000);
      return {
        rearm: lost < max.lost,
        state: { ...state, lost },
        // Jittered because every agent on the service reconnects to the same
        // broker: an unjittered backoff brings them all back in lockstep and
        // knocks over the thing they were waiting for.
        delayMs: Math.round(ceiling * (0.5 + jitter() * 0.5)),
        warn: null,
      };
    }

    // The broker offered more peers than the protocol allows. That is not a
    // guess and not a network fault, so there is nothing to back off from —
    // stop, and say why.
    case "too-many-peers":
      return { rearm: false, state, delayMs: 0, warn: "broker-misbehaving" };
  }
}

function cliVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(path.resolve(DIST_DIR, "../package.json"), "utf8"),
    ) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export type StartOpts = {
  port: number;
  /** Undefined means "decide for me" — see `resolveHost`. */
  host?: string;
  token?: string;
  open: boolean;
  allowedPaths?: string;
  /** LAN and loopback only. Never contacts a broker, by choice rather than by
   * accident — which is a different thing from the tunnel merely failing. */
  local: boolean;
  qr: boolean;
  name?: string;
  api?: string;
  json: boolean;
  /** Mirror the relay's log to stderr, at debug, while this runs. */
  verbose?: boolean;
  /** Override the level written to `~/.mtmux/logs/mtmux.log`. */
  logLevel?: string;
  /**
   * Scope the printed code to these tmux sessions.
   *
   * `mtmux start --share work` is "serve this machine for me, and hand out a
   * code that only reaches `work`". Without it the code means the whole
   * machine, which is what it has always meant.
   */
  share?: string;
  shareReadOnly?: boolean;
  shareFiles?: GrantFiles;
  /**
   * Override `reconnectPolicy` for this run.
   *
   * Both spellings, because a flag that can only turn a stored setting *on* is
   * half a flag: someone who has set `confirm` and is about to reboot a machine
   * they will not be sitting at needs a way to say so once.
   */
  confirmReconnect?: boolean;
  trustReconnect?: boolean;
};

/**
 * Bind the LAN by default when there is one.
 *
 * The old default of 127.0.0.1 made the phone-on-the-couch case — the entire
 * point of the tool — require a restart with `--host 0.0.0.0`. The relay
 * refuses to serve a default/empty token on a non-loopback bind, and the CLI
 * always has a 32-byte random token, so opening up the bind does not open up
 * access.
 */
export function resolveHost(
  explicitHost: string | undefined,
  lan: LanAddress | null,
): string {
  if (explicitHost) return explicitHost;
  return lan ? "0.0.0.0" : "127.0.0.1";
}

/**
 * The address to actually show people, which is never the bind address:
 * "0.0.0.0" is not somewhere you can point a browser, and the old banner
 * rewrote it to "localhost", which is wrong on every device but this one.
 */
export function resolveLanUrl(
  host: string,
  port: number,
  lan: LanAddress | null,
): string | null {
  if (LOOPBACK.has(host)) return null;
  if (WILDCARD.has(host)) return lan ? `http://${lan.address}:${port}` : null;
  return `http://${host}:${port}`;
}

/**
 * Where the browser that scans the code should land.
 *
 * This is not the broker. The broker relays sealed frames; the *app* is what
 * renders the join page and the terminal, and on the hosted service they are
 * deliberately separate origins so a compromise of one is not a compromise of
 * the other.
 *
 * The `api.` → `app.` swap covers that hosted naming. It cannot cover a
 * self-hosted deployment, where the two origins are whatever the operator
 * chose — hence the override, which is the only way a self-hoster can print a
 * QR that points at their own app. Falling back to the broker origin is the
 * least-wrong default: a single-origin deployment serves both from there, and
 * anything else is unguessable.
 */
export function appOriginFor(base: string, env = process.env): string {
  const override = env.MTMUX_APP_URL;
  if (override) return override.replace(/\/+$/, "");
  if (base.includes("//api.")) return base.replace("//api.", "//app.");
  return base;
}

/** What the QR encodes. The code rides in the fragment, so it never reaches a server. */
export function joinUrl(appOrigin: string, code: string): string {
  return `${appOrigin}/j#${code}`;
}

type Hosted = {
  agent: TunnelAgent;
  invite: PairingInvite;
  /** Mint a code on demand, after arming has gone idle. */
  rearm: () => Promise<PairingInvite>;
  stop: () => void;
};

/**
 * The two halves of an invite.
 *
 * `typed` is the digits a human reads off the screen; `scan` is the QR's
 * 128-bit secret. They were once armed and re-armed as a unit, which stopped
 * being right the moment they got separate slot spaces: a sweep of the typed
 * slots kills the typed code and never touches the scanned one, and a shared
 * fate would leave the machine silent until the untouched half timed out.
 */
type HalfKind = "typed" | "scan";

/** Why a fresh code appeared, so the CLI can say something true about it. */
export type RearmReason = "paired" | "expired" | "wrong-code" | "lost";

/** What the human is told when a half fails, before the replacement arrives. */
export type RearmNotice = {
  warning: RearmWarning;
  /** Which half failed. Only `typed` can be meaningfully guessed at. */
  half: HalfKind;
  /** Consecutive wrong codes for this half, for "wrong code again (4)". */
  wrong: number;
  /** How long until the replacement. */
  delayMs: number;
};

/**
 * Bring up the tunnel and arm a pairing code.
 *
 * Ordering matters: the tunnel must be registered before a code is offered,
 * because the descriptor the CLI seals at the end of the handshake has to name
 * a tunnel that already exists. Arming the code first would produce a race in
 * which a very fast phone pairs against a tunnel id that is still undefined.
 */
/**
 * The approval window, once `start` has bound the server.
 *
 * Module-level because the two halves live in different functions and start in
 * a fixed order: `startHosted` creates the tunnel agent — and with it
 * `onAccessRequest` — before `start` binds the port the control plane listens
 * on. A parameter would mean either reordering the boot or handing the agent a
 * value that is still null when it is captured.
 */
let approvals: ApproveControl | null = null;

/**
 * The in-app approval channel, once the relay runtime is loaded.
 *
 * Module-level for exactly the reason `approvals` is, and set at the same
 * moment: the tunnel agent that closes over `onAccessRequest` is built before
 * the relay bundle is imported. Null until then, and null forever against a
 * relay bundle that predates the feature — in which case `decideAccess` falls
 * back to the TTY and `mtmux approve` unchanged.
 */
let askInApp:
  | ((
      req: { sas: string; deviceLabel: string; accountEmail: string },
      opts: { signal: AbortSignal },
    ) => Promise<boolean | null>)
  | null = null;

/** How many devices are connected right now, for what the parked notice says. */
let connectedCount: (() => number) | null = null;

async function startHosted(opts: {
  port: number;
  base: string;
  cfg: configStore.Config;
  tunnelOnly: boolean;
  /**
   * Scope every code this loop arms, for `mtmux start --share`.
   *
   * A function rather than a value because a fresh grant id is minted per
   * pairing — two people who scan the same-shaped share still get separately
   * revocable credentials, which is the whole point of `share revoke`.
   */
  buildGrant?: (directToken: string) => GrantRecord;
  /**
   * Pairings recovered from disk, admitted the moment the agent exists.
   *
   * Passed in rather than read here because the relay credential half of the
   * restore has to happen before the port is even bound, while this half cannot
   * happen until `createTunnelAgent` has returned. Splitting the two is what
   * lets each run at the only moment it can.
   */
  trusted?: RestoredPeer[];
  onPaired: (label: string) => void;
  /** A restored device came back on the tunnel, named. */
  onReturned?: (peer: PeerIdentity) => void;
  /**
   * Ask before admitting a device that paired in an earlier run.
   *
   * Undefined means the default: paired is paired, which is what every release
   * so far has done and what an unattended server needs.
   */
  confirmReturning?: (peer: PeerIdentity) => Promise<boolean>;
  onRearm: (invite: PairingInvite, reason: RearmReason) => void;
  /**
   * A half failed in a way worth saying out loud, and its replacement is
   * `delayMs` away. Fires before the delay, so the terminal is never silent
   * for two minutes with no explanation.
   */
  onWarn?: (notice: RearmNotice) => void;
  /**
   * Every code has expired untouched and no more will be minted until the user
   * asks. Undefined means the caller does not care and arming simply stops.
   */
  onIdle?: () => void;
  /**
   * The tunnel came up after the boot deadline had already passed.
   *
   * Fires at most once, on a machine that has been serving locally in the
   * meantime. Absent means the caller does not want a late tunnel, and the
   * agent is stopped for good when the deadline passes.
   */
  onLateTunnel?: (hosted: Hosted) => void;
  /**
   * A way to stop the tunnel agent, handed over as soon as there is one.
   *
   * Separate from the returned `Hosted` because the interesting case is the one
   * where this function throws: after the boot deadline the agent is
   * deliberately left retrying, and without this the caller has no handle on it
   * to shut down.
   */
  onAgent?: (stop: () => void) => void;
}): Promise<Hosted> {
  const { key } = await configStore.ensureDeviceKey();

  // The agent signals readiness through a callback rather than a promise, so
  // wrap it in one — nothing below can run until the tunnel has an id.
  let announce!: (tunnelId: string) => void;
  const ready = new Promise<string>((resolve) => {
    announce = resolve;
  });

  const agent = createTunnelAgent({
    apiBase: opts.base,
    deviceKey: key,
    connectBroker: brokerConnector(),
    connectLocal: localRelayConnector(opts.port),
    onTunnelReady: announce,
    /**
     * A signed-in browser asking to be let in.
     *
     * Everything cryptographic has already happened by the time this runs; all
     * that is left is to show a human six digits and do as they say. Approving
     * then follows exactly the same path a scanned code does — register the
     * derived token with the relay, admit the keys, remember the peer — so a
     * requested pairing and a scanned one produce an identical session.
     */
    onAccessRequest: async (request) => {
      // An open `mtmux approve` window decides; otherwise the TTY prompt;
      // otherwise `no-tty`. See `decideAccess` for why "nobody is waiting" and
      // "they said no" must stay distinguishable.
      const answer = await decideAccess(request, {
        /**
         * The phone already holding a session is asked first — at the same
         * time as everything else, and with the same six digits on screen.
         *
         * This is the channel that matters on the product's own premise: if
         * you are using mtmux, you are by definition not at the machine, and
         * before this the machine was the only thing that could say yes.
         */
        ask: askInApp ? (req, signal) => askInApp!(req, { signal }) : undefined,
        offer: approvals ? (req) => approvals!.offer(req) : undefined,
        // Reached only when the TTY prompt could not ask at all, which is the
        // common case rather than the exotic one: a machine started by systemd,
        // by `nohup`, or left in a detached pane. Rather than denying instantly
        // while the user sits there watching the output, hold the request for
        // the offer window and tell them how to answer it.
        park: approvals
          ? (req, signal) =>
              approvals!
                .offer(req, { park: true, signal })
                .then((v) => v === true)
          : undefined,
        onParked: (req) => {
          clearWaitingLine();
          console.log("");
          console.log(
            kleur.bold("  A browser wants to pair with this machine"),
          );
          console.log("");
          console.log(
            `    ${kleur.dim("Device ")}  ${displayLabel(req.deviceLabel, "unknown device")}`,
          );
          console.log(
            `    ${kleur.dim("Account")}  ${displayLabel(req.accountEmail, "unknown account")}`,
          );
          console.log(
            `    ${kleur.dim("Code   ")}  ${kleur.bold(formatSas(req.sas))}`,
          );
          console.log("");
          // Two different true things to say, and saying the wrong one is how
          // a security prompt teaches people to ignore it. "I cannot ask here"
          // is false the moment a phone is showing the dialog.
          const asked = connectedCount?.() ?? 0;
          if (asked > 0) {
            console.log(
              kleur.dim(
                `    Asked the ${asked === 1 ? "device" : `${asked} devices`} already connected — answer there,`,
              ),
            );
            console.log(
              kleur.dim("    or run ") +
                kleur.bold("mtmux approve") +
                kleur.dim(" in another shell. Either way, compare the code."),
            );
          } else {
            console.log(
              kleur.dim(
                "    Nothing is attached to this terminal, so I cannot ask here.",
              ),
            );
            console.log(
              kleur.dim("    Run ") +
                kleur.bold("mtmux approve") +
                kleur.dim(" in another shell, then compare the code."),
            );
          }
          console.log("");
        },
      });
      if (!answer.approved) {
        // Logged locally so a refusal leaves a trace on the machine that
        // refused it. The broker is told nothing beyond "denied".
        console.log(
          kleur.dim(
            `    Refused an access request from ${request.accountEmail}.`,
          ),
        );
        return { approved: false, reason: answer.reason };
      }

      // Minted before registration so the relay can name this peer when it
      // reports the device using its token; the peer record below reuses it.
      const deviceId = `browser-${Date.now().toString(36)}`;

      // Registration before admission, for the same reason as the code path:
      // admitting the keys first lets the browser authenticate against a relay
      // that has never heard of its token.
      const registered = await registerDirectToken(
        opts.port,
        opts.cfg.token,
        request.keys.directToken,
        undefined,
        { label: request.deviceLabel, via: "request" },
        configStore.PEER_EXPIRY_MS,
        deviceId,
      );
      if (!registered) {
        console.log(
          kleur.red("  ✗ Could not register the session. Nothing was shared."),
        );
        return { approved: false, reason: "refused" };
      }

      const sealed = await sealDescriptor(request.keys, {
        candidates: opts.tunnelOnly ? [] : buildCandidates(opts.port, null),
        tunnelId: await ready,
        deviceId: key.deviceId,
        publicKey: Buffer.from(key.publicKey).toString("hex"),
        label: deviceLabel(),
      });

      agent.addSessionKeys(request.keys, {
        deviceId,
        label: request.deviceLabel,
        restored: false,
      });
      await configStore.addPeer({
        deviceId,
        publicKey: "",
        label: request.deviceLabel,
        pairedAt: Date.now(),
        lastSeenAt: Date.now(),
        directToken: request.keys.directToken,
        sessionKeys: encodeSessionKeys(request.keys),
      });
      console.log(
        kleur.green(
          `  ✓ ${displayLabel(request.deviceLabel, "A device")} connected.`,
        ),
      );

      return { approved: true, sealedDescriptor: bytesToBase64Url(sealed) };
    },
    onStreamBound: (peer) => {
      if (peer?.restored) opts.onReturned?.(peer);
    },
    admitStream: opts.confirmReturning
      ? async (peer) => {
          // Only devices restored from disk are gated. One that paired in this
          // process was approved seconds ago, by someone standing here typing
          // a code — asking again would be asking the same question twice.
          if (!peer?.restored) return true;
          return opts.confirmReturning!(peer);
        }
      : undefined,
  });

  // Before `start()`, so a device that reconnects the instant the tunnel comes
  // up finds its key already on the ring rather than racing it.
  for (const peer of opts.trusted ?? []) {
    agent.addSessionKeys(peer.keys, peer.identity);
  }

  agent.start();

  /**
   * Everything that cannot happen until the tunnel has an id.
   *
   * A function rather than straight-line code because the tunnel is allowed to
   * arrive late. `mtmux start` gives the broker fifteen seconds before it
   * settles for serving locally, and that deadline used to be final: it called
   * `agent.stop()`, which disables the agent's reconnect permanently. One slow
   * or briefly-unreachable broker at boot therefore cost the tunnel for the
   * whole life of the process, with a single dim line to explain it. Now the
   * deadline only stops the *waiting* — the agent keeps retrying, and this runs
   * unchanged whenever it gets through.
   */
  const finishHosting = async (): Promise<Hosted> => {
    const appOrigin = appOriginFor(opts.base);

    /**
     * Failure budgets, one set per half.
     *
     * Per-half because the halves stopped sharing a fate once the QR got its own
     * slot space. A sweep of the typed slot space kills typed codes and
     * cannot touch a four-digit scan slot, so a shared counter would either bill
     * the QR for the typed code's attacker or let the typed code coast on the
     * QR's silence. See `rearmDecision` for why nothing but a completed pairing
     * resets these.
     */
    const failures: Record<HalfKind, RearmState> = {
      typed: { ...NO_FAILURES },
      scan: { ...NO_FAILURES },
    };

    /**
     * The scan half's secret is 128 bits, so a failure there is never a guess —
     * it is a claim that could not confirm, i.e. a bug or a stray client. The
     * budget exists only so a misbehaving peer cannot spin the loop.
     */
    const limitsFor = (half: HalfKind): RearmLimits =>
      half === "scan" ? { wrong: 20 } : {};

    /** The live pairing behind each half, or null once it has stopped arming. */
    const live: Record<HalfKind, HostedPairing | null> = {
      typed: null,
      scan: null,
    };

    /**
     * Which round each wired half belongs to.
     *
     * A successful pairing ends the round and cancels the other half, whose
     * rejection then lands a microtask later. Without a token to check against,
     * that late rejection would be read as a failure of the *new* round and
     * re-arm on top of a code that had just been printed. This is the same job
     * the old `decided` flag did, done in a way that survives the round being
     * restarted immediately.
     */
    let round = 0;

    /** Timers for delayed re-arms, so `stop()` does not leave one pending. */
    const pending = new Set<NodeJS.Timeout>();

    const hostOpts = () => ({
      apiBase: opts.base,
      buildDescriptor: () => {
        // Read through to the agent rather than closing over the id captured at
        // boot: `createTunnelAgent` reconnects on its own and comes back with a
        // new id, so a code re-armed after a broker restart would otherwise seal
        // a descriptor naming a tunnel that no longer exists — the browser pairs
        // successfully and then cannot connect to anything.
        const id = agent.tunnelId;
        if (id === null) throw new PairingError("The tunnel is not connected.");
        return {
          candidates: opts.tunnelOnly ? [] : buildCandidates(opts.port, null),
          tunnelId: id,
          deviceId: key.deviceId,
          publicKey: Buffer.from(key.publicKey).toString("hex"),
          label: deviceLabel(),
        };
      },
      seal: sealDescriptor,
    });

    const inviteNow = (): PairingInvite => ({
      code: live.typed?.code ?? null,
      // The QR carries the long secret; only `code` is meant to be read aloud.
      url: live.scan ? joinUrl(appOrigin, live.scan.code) : null,
      host: appOrigin.replace(/^https?:\/\//, ""),
    });

    /**
     * Park one half's mailbox and wire up what happens when it settles.
     *
     * Two mailboxes rather than one, because a mailbox commits to a single CPace
     * password the moment it answers a claim — so a typed secret and a 128-bit
     * one cannot share it. They are raced: whichever is claimed first wins the
     * round and the other is cancelled, which destroys its mailbox immediately
     * rather than leaving a live code nobody is watching.
     *
     * The point of the pair is that scanning a QR is not typing. Nobody reads a
     * 128-bit secret off a screen, so there is no reason for the path almost
     * everyone uses to carry the entropy of the fallback.
     */
    const armHalf = async (half: HalfKind): Promise<HostedPairing> => {
      const myRound = round;
      const pairing = await hostPairing({
        ...hostOpts(),
        secret: half === "typed" ? generateSecret() : generateLongSecret(),
        space: half,
      });
      live[half] = pairing;

      void pairing.paired
        .then(async (result) => {
          if (myRound !== round) return;
          round += 1;
          // The round is over, so the sibling code must stop being claimable.
          const other: HalfKind = half === "typed" ? "scan" : "typed";
          live[other]?.cancel();
          live.typed = null;
          live.scan = null;

          // Registration BEFORE the agent will admit the keys, and this order is
          // load-bearing now that the tunnel agent no longer injects the
          // machine's own token. Admitting the keys first opens a window in
          // which the browser can win the race, send its `auth` frame down the
          // tunnel, and be refused because the relay has never been told about
          // that token. A failure here must therefore *not* admit the keys.
          const grant = opts.buildGrant?.(result.keys.directToken);
          const peerDeviceId =
            result.peerDeviceId ?? `browser-${Date.now().toString(36)}`;
          const registered = await registerDirectToken(
            opts.port,
            opts.cfg.token,
            result.keys.directToken,
            grant,
            { label: result.peerLabel, via: "code" },
            configStore.PEER_EXPIRY_MS,
            peerDeviceId,
          );
          // A scoped pairing that could not be registered must not be admitted:
          // the alternative is a browser that authenticates against a relay
          // which has never heard of its token, and so falls through to nothing.
          if (grant && !registered) {
            console.log(
              kleur.red(
                "  ✗ Could not register the share. Nothing was shared.",
              ),
            );
            return;
          }
          agent.addSessionKeys(result.keys, {
            deviceId: peerDeviceId,
            label: result.peerLabel,
            restored: false,
          });
          if (grant) await grantsStore.add(grant);
          await configStore.addPeer({
            deviceId: peerDeviceId,
            publicKey: result.peerPublicKey ?? "",
            label: result.peerLabel,
            pairedAt: Date.now(),
            lastSeenAt: Date.now(),
            directToken: result.keys.directToken,
            sessionKeys: encodeSessionKeys(result.keys),
            // Without this the scope is lost at the process boundary and
            // `restoreTrustedDevices` re-registers a read-only share with the
            // run of the machine.
            ...(grant ? { grantId: grant.id } : {}),
          });
          opts.onPaired(result.peerLabel);
          // The one thing that clears the budgets: a pairing that completed.
          failures.typed = { ...NO_FAILURES };
          failures.scan = { ...NO_FAILURES };
          opts.onRearm(await armRound(), "paired");
        })
        .catch((err: unknown) => {
          if (myRound !== round) return;
          live[half] = null;

          const decision = rearmDecision(err, failures[half], limitsFor(half));
          failures[half] = decision.state;

          if (decision.warn) {
            opts.onWarn?.({
              warning: decision.warn,
              half,
              wrong: decision.state.wrong,
              delayMs: decision.rearm ? decision.delayMs : 0,
            });
          }

          if (!decision.rearm) {
            // Nothing left to claim on either half — the invite is spent, and
            // only a human may bring it back. On a machine with no TTY that is
            // simply where arming stops, which is the fail-closed direction.
            if (!live.typed && !live.scan) opts.onIdle?.();
            return;
          }

          const reason: RearmReason =
            decision.warn === null ? failureKindReason(err) : "wrong-code";
          const again = () => {
            void armHalf(half)
              .then(() => opts.onRearm(inviteNow(), reason))
              .catch((armErr: unknown) => {
                // Arming itself failed — a 503, a dead tunnel. Say so and try
                // again on the same budget rather than going quiet with no code.
                console.log(
                  kleur.yellow(
                    `  ! Could not get a fresh code (${(armErr as Error).message}).`,
                  ),
                );
                scheduleRearm(REARM_RETRY_MS);
              });
          };
          const scheduleRearm = (delayMs: number) => {
            if (delayMs <= 0) {
              again();
              return;
            }
            const timer = setTimeout(() => {
              pending.delete(timer);
              again();
            }, delayMs);
            timer.unref();
            pending.add(timer);
          };
          scheduleRearm(decision.delayMs);
        });

      return pairing;
    };

    /** Arm both halves as one fresh round. */
    const armRound = async (): Promise<PairingInvite> => {
      await Promise.all([armHalf("typed"), armHalf("scan")]);
      return inviteNow();
    };

    const invite = await armRound();
    return {
      agent,
      invite,
      /** Mint a code on demand, after arming has gone idle. */
      rearm: async () => {
        round += 1;
        failures.typed = { ...NO_FAILURES };
        failures.scan = { ...NO_FAILURES };
        live.typed?.cancel();
        live.scan?.cancel();
        live.typed = null;
        live.scan = null;
        return armRound();
      },
      stop: () => {
        for (const timer of pending) clearTimeout(timer);
        pending.clear();
        agent.stop();
      },
    };
  };

  /**
   * The boot deadline, kept separate from `ready`.
   *
   * `ready` must stay pending rather than reject, because a rejected promise
   * can never deliver the tunnel id that arrives two minutes later — and
   * delivering it is the entire point of not giving up.
   */
  const deadline = new Promise<never>((_, reject) => {
    const timer = setTimeout(
      () => reject(new Error("the broker did not answer")),
      TUNNEL_READY_TIMEOUT_MS,
    );
    timer.unref?.();
    void ready.then(
      () => clearTimeout(timer),
      () => clearTimeout(timer),
    );
  });
  // Nothing awaits `deadline` once `ready` wins the race, and an unobserved
  // rejection would take the process down.
  deadline.catch(() => {});

  /*
   * Hand the caller a way to stop the agent even if hosting never completes.
   *
   * On the late-tunnel path this function throws, so `hosted` is never
   * assigned and `shutdown()`'s `hosted?.stop()` is a no-op — leaving the
   * agent's backoff loop and an open broker socket running after Ctrl-C, on a
   * socket that is not unref'd, so the process would not exit.
   */
  opts.onAgent?.(() => agent.stop());

  try {
    await Promise.race([ready, deadline]);
  } catch (err) {
    if (opts.onLateTunnel) {
      // Deliberately not `agent.stop()`: the agent's own backoff loop is the
      // only thing that can recover from a broker that was merely slow, and
      // stopping it is what turned a fifteen-second hiccup into a process that
      // would never be reachable from outside the LAN again.
      void ready.then(
        async () => {
          try {
            opts.onLateTunnel?.(await finishHosting());
          } catch {
            // Arming a code late is best-effort. The LAN server is already up
            // and already told the user it is on its own; failing here must
            // not take it down.
          }
        },
        () => {},
      );
    } else {
      // No caller to hand a late tunnel to, so leave nothing retrying.
      agent.stop();
    }
    throw err;
  }

  return finishHosting();
}

/** How long to wait before retrying an arm that failed outright. */
const REARM_RETRY_MS = 10_000;

/** The dim line above a replacement code, chosen by what killed the last one. */
const REARM_LINES: Record<RearmReason, string> = {
  paired: "Here's a fresh code for the next device:",
  expired: "That code expired. Here's another:",
  "wrong-code": "Here's the fresh code:",
  lost: "Reconnected. Here's a fresh code:",
};

/**
 * Whether the bottom of the screen is still the banner's "Waiting for a device…".
 *
 * The banner always ends with that line and a blank one, and the claim stops
 * being true the moment something connects. Tracking it is what lets a
 * confirmation *replace* the stale line rather than be printed underneath it,
 * with both on screen at once saying opposite things.
 */
let waitingLineOnScreen = false;

/**
 * Erase the banner's trailing "Waiting…" block, if it is what is on screen.
 *
 * A pipe, a service unit or a `--json` run has no cursor to move, so there the
 * line simply stays — which is correct: nothing is corrupted and the output is
 * still append-only for anything reading it.
 */
function clearWaitingLine(): void {
  if (!waitingLineOnScreen) return;
  waitingLineOnScreen = false;
  if (!process.stdout.isTTY) return;
  // Up two (the blank line, then the waiting line) and erase to the end.
  process.stdout.write("\x1b[2A\x1b[0J");
}

/**
 * Say who is connected, as it changes.
 *
 * `mtmux start` used to go silent after the banner: a device could attach,
 * drop, or never arrive at all and the terminal looked identical. The count is
 * the thing people actually want from a screen they leave open — "is my phone
 * still on?" and, less comfortably, "is that only my phone?"
 *
 * Append-only rather than a status line rewritten in place. The banner already
 * owns the bottom of the screen through `waitingLineOnScreen`, and a second
 * writer moving the cursor would corrupt the QR the moment the two coincided.
 * Clearing the waiting line first is the same courtesy every other event here
 * pays, and it keeps the output honest in a pipe or a service unit.
 *
 * Silent under `--json`, which promises one parseable document and nothing
 * else, and a no-op against a relay bundle that predates the subscription.
 */
function watchConnectedDevices(relay: RelayRuntime, json: boolean): void {
  const summary = relay.connectionSummary;
  const subscribe = relay.onConnectionsChanged;
  if (json || !summary || !subscribe) return;

  let previous = summary().devices.map((d) => d.label);

  subscribe(() => {
    const current = summary().devices.map((d) => d.label);
    const arrived = missingFrom(current, previous);
    const departed = missingFrom(previous, current);
    previous = current;
    if (arrived.length === 0 && departed.length === 0) return;

    clearWaitingLine();
    for (const label of arrived) {
      console.log(kleur.green(`  ✓ ${label} connected.`));
    }
    for (const label of departed) {
      console.log(kleur.dim(`  · ${label} disconnected.`));
    }
    console.log(kleur.dim(`    ${devicesOnline(current.length)}`));
    console.log("");
  });
}

/**
 * Multiset difference: what is in `a` that `b` does not account for.
 *
 * A set would collapse two phones running the same browser into one entry, so
 * closing one tab of two would report a disconnect that did not happen.
 */
export function missingFrom(a: string[], b: string[]): string[] {
  const remaining = [...b];
  const out: string[] = [];
  for (const item of a) {
    const at = remaining.indexOf(item);
    if (at === -1) out.push(item);
    else remaining.splice(at, 1);
  }
  return out;
}

export function devicesOnline(count: number): string {
  if (count === 0) return "Nothing is connected now.";
  return `${count} device${count === 1 ? "" : "s"} connected.`;
}

/**
 * The reconnect gate, remembering what it was already told.
 *
 * Cached per device for the process lifetime: a browser opens a stream per tab
 * and reconnects on every network blip, so asking per stream would turn one
 * policy decision into a prompt that never stops. The cache is deliberately
 * *not* persisted — the whole point of `confirm` is that a restart is where
 * the question gets asked again.
 *
 * Concurrent streams from the same device share one prompt rather than racing
 * two, which is why the map holds the promise and not the answer.
 */
function makeReturningGate(): (peer: PeerIdentity) => Promise<boolean> {
  const decided = new Map<string, Promise<boolean>>();

  return (peer) => {
    const existing = decided.get(peer.deviceId);
    if (existing) return existing;

    const asking = (async () => {
      clearWaitingLine();
      const answer = await promptForReturningDevice({ label: peer.label });
      if (answer.approved) {
        console.log(kleur.green(`  ✓ ${peer.label} let back in.`));
        console.log("");
        return true;
      }
      if (answer.reason === "no-tty") {
        // Refusing is the setting applying. Admitting because nobody could be
        // asked would be the setting quietly not applying, which is the worst
        // outcome available for a control someone deliberately turned on.
        console.log(
          kleur.yellow(`  ! Refused ${peer.label}: nothing to ask on.`),
        );
        console.log(
          kleur.dim("    Start with ") +
            kleur.bold("--trust-reconnect") +
            kleur.dim(", or ") +
            kleur.bold("mtmux config set reconnectPolicy trust") +
            kleur.dim("."),
        );
      } else {
        console.log(kleur.dim(`  · Refused ${peer.label}.`));
      }
      console.log("");
      return false;
    })();

    decided.set(peer.deviceId, asking);
    return asking;
  };
}

/** The reason wording for a failure that carried no warning of its own. */
function failureKindReason(err: unknown): RearmReason {
  return err instanceof PairingError && err.kind === "expired"
    ? "expired"
    : "lost";
}

/**
 * Re-admit every device that has paired with this machine before.
 *
 * The relay holds session tokens in memory, so without this a restart silently
 * un-pairs every phone that ever connected — and "restart" includes a deploy, a
 * crash and a reboot. Replaying the tokens we already negotiated turns a paired
 * device into what the word implies: trusted until revoked.
 *
 * Expired and revoked peers are skipped, and a failure is ignored — the device
 * simply pairs again, which is the pre-existing behaviour.
 */
/** A device whose pairing survived the restart, ready to re-enter the keyring. */
export type RestoredPeer = { keys: SessionKeys; identity: PeerIdentity };

export type RestoreResult = {
  /** Devices whose relay credential was replayed successfully. */
  restored: number;
  /** Devices with no stored credential at all; they must pair again. */
  needRepair: number;
  /**
   * Devices reachable directly but not through the tunnel, because they were
   * paired before the key schedule was persisted. A strictly smaller loss than
   * `needRepair`, and a different sentence on screen.
   */
  needRekey: number;
  trusted: RestoredPeer[];
};

export async function restoreTrustedDevices(
  port: number,
  authToken: string,
  /**
   * Injected so this is testable without a running relay. The registration is
   * an HTTP POST to loopback, and standing one up per case would test `fetch`
   * rather than the restore logic that actually regressed.
   */
  register: typeof registerDirectToken = registerDirectToken,
  now: number = Date.now(),
): Promise<RestoreResult> {
  const peers = await configStore.listPeers();
  let restored = 0;
  let needRepair = 0;
  let needRekey = 0;
  const trusted: RestoredPeer[] = [];

  /*
   * Scoped peers get their scope back, or they do not come back at all.
   *
   * An omitted grant means the full grant to the relay, so re-registering a
   * `mtmux share` token without one silently promoted a read-only,
   * single-session share to full machine access on the next restart. Read once
   * here rather than per peer — most installs have no grants at all.
   */
  const grantsById = new Map(
    (await grantsStore.active(now)).map((g) => [g.id, g]),
  );

  for (const peer of peers) {
    if (configStore.isPeerExpired(peer, now)) continue;
    const grant = peer.grantId ? grantsById.get(peer.grantId) : undefined;
    if (peer.grantId && !grant) {
      // The share it belonged to has expired or been revoked. Restoring it
      // unscoped is the escalation; restoring it at all is wrong.
      continue;
    }
    if (!peer.directToken) {
      // Paired before `directToken` was stored. These used to work over the
      // tunnel *only* because the agent injected the machine's own token on
      // the loopback socket — which is the hole that scoping closes, so they
      // genuinely have no credential now. One-time, and re-pairing is six
      // digits, but it must be said out loud rather than failing silently.
      needRepair += 1;
      continue;
    }
    // The relay holds session tokens in memory only, so every boot re-derives
    // this window rather than resuming one. Handing it what the peer record
    // has left is what stops the relay from running a shorter clock than the
    // trust it is standing in for — the bug that made a paired phone stop
    // working a day later while `mtmux start` still listed it as trusted.
    if (
      !(await register(
        port,
        authToken,
        peer.directToken,
        grant,
        { label: peer.label, via: "code" },
        configStore.peerLifetimeRemainingMs(peer, now),
        peer.deviceId,
      ))
    ) {
      continue;
    }
    restored += 1;

    // The relay now knows this device again, which is the direct/LAN path. The
    // tunnel needs the key schedule as well, and a peer stored before those
    // were persisted has none — it keeps working at home and cannot be reached
    // from anywhere else until it pairs once more.
    if (!peer.sessionKeys) {
      needRekey += 1;
      continue;
    }
    try {
      trusted.push({
        keys: decodeSessionKeys(peer.sessionKeys),
        identity: {
          deviceId: peer.deviceId,
          label: peer.label,
          restored: true,
        },
      });
    } catch {
      // Corrupted or hand-edited. Same outcome as never having had them, and
      // for the same reason `ensureDeviceKey` replaces rather than trusts one.
      needRekey += 1;
    }
  }

  return { restored, needRepair, needRekey, trusted };
}

/**
 * Keep the registry's view of this machine fresh.
 *
 * Every failure is swallowed. A machine whose owner's card expired, or whose
 * network dropped, must keep serving its own terminal — the registry is a
 * convenience layered on top, never a licence check.
 */
function startHeartbeat(
  base: string,
  token: string,
  serverId: string,
): () => void {
  const timer = setInterval(() => {
    void account.heartbeat(base, token, serverId);
  }, HEARTBEAT_MS);
  timer.unref();
  return () => clearInterval(timer);
}

async function registerWithAccount(
  base: string,
  name: string,
  publicKey: string,
): Promise<(() => void) | null> {
  const signedIn = await configStore.getAccount(base);
  if (!signedIn) return null;

  try {
    const result = await account.registerServer(base, signedIn.token, {
      name,
      publicKey,
      hostname: os.hostname(),
      platform: `${process.platform}-${process.arch}`,
      cliVersion: cliVersion(),
    });
    if (!result.ok) {
      console.log(kleur.yellow(`  ! ${result.reason}`));
      if (result.upgradeUrl) {
        console.log(kleur.dim(`    ${result.upgradeUrl}`));
      }
      return null;
    }
    if (result.trialStarted) {
      // The most important line of copy in this feature. What someone hits
      // here used to be a 402 telling them to get out a card; it is now this.
      console.log(
        kleur.green(
          `  ✓ Started your ${result.trialDaysLeft}-day Pro trial — no card needed.`,
        ),
      );
    }
    await configStore.setAccount({ ...signedIn, serverId: result.serverId });
    return startHeartbeat(base, signedIn.token, result.serverId);
  } catch {
    // Being signed in must never be worse than being anonymous.
    return null;
  }
}

export async function start(opts: StartOpts) {
  checkNode();
  await checkTmux();

  const version = cliVersion();
  const lan = primaryLanAddress();
  const host = resolveHost(opts.host, lan);
  const base = await resolveApiBase(opts.api);

  /*
   * The update check, started here and read after the banner.
   *
   * In flight while the relay boots and the tunnel is negotiated, so by the
   * time anything is printed it has almost always already answered — and if it
   * has not, it is capped and its failure is silence. `--local` never asks:
   * invariant #4 says that path contacts nobody, and a version check is still
   * contact. `--json` never asks either, because the document it prints is a
   * contract and an advisory is not part of it.
   */
  const updateCheck =
    opts.local || opts.json
      ? Promise.resolve(null)
      : fetchBrokerVersion(base).catch(() => null);

  const cfg = opts.token ? { token: opts.token } : await configStore.load();
  // Relay reads these on first import. Set BEFORE we import relay modules.
  process.env.AUTH_TOKEN = cfg.token;
  process.env.ALLOWED_PATHS =
    opts.allowedPaths ??
    process.env.ALLOWED_PATHS ??
    process.env.HOME ??
    process.cwd();
  (process.env as Record<string, string>).NODE_ENV = "production";
  process.env.RELAY_HOST = host;
  process.env.RELAY_PORT = String(opts.port);

  // The relay's logger reads its config once, at import, and writes to fd 1 —
  // the same stream as the banner. Without this every pane click, split and
  // resize prints raw NDJSON, pid and hostname included, straight through the
  // QR code. This is the only place the redirect can be set: the dynamic import
  // below is what evaluates `packages/logger`.
  //
  // `mtmux logs` is the other half of the trade; taking the output away without
  // giving it somewhere would be a debuggability regression, not a fix.
  await rotateIfNeeded();
  process.env.LOG_FILE ??= LOG_PATH;
  process.env.LOG_LEVEL ??= opts.logLevel ?? (opts.verbose ? "debug" : "info");

  // `--verbose` puts the log back on screen, but on **stderr** — so `--json`
  // stays a parseable document on stdout, and so the banner is still the only
  // thing a user who did not ask for logs ever sees. Tailing the file rather
  // than adding a second pino destination keeps one writer and one format.
  const stopMirror = opts.verbose
    ? followLog((line) => process.stderr.write(`${formatLogLine(line)}\n`))
    : null;
  // Single-origin in CLI mode — no cross-origin requests possible. Set the
  // CORS allow-list to empty so the relay's prod gate doesn't reject the
  // localhost default.
  if (process.env.CORS_ORIGINS === undefined) process.env.CORS_ORIGINS = "";

  const [relay, nextMod] = await Promise.all([
    import(RELAY_RUNTIME) as Promise<RelayRuntime>,
    import("next"),
  ]);

  const nextFactory = (
    nextMod as unknown as { default: typeof import("next").default }
  ).default;
  const app = nextFactory({ dev: false, dir: WEB_DIR });
  await app.prepare();

  /**
   * The loopback control plane for `mtmux approve`.
   *
   * Created before `serve` because the handler is wired into it, and reached by
   * `onAccessRequest` above — which is why it is defined here rather than
   * inside the tunnel agent's options.
   */
  const approveControl = createApproveControl({ authToken: cfg.token });
  approvals = approveControl;
  // Optional on the runtime, so a bundle that predates in-app approval leaves
  // this null and the TTY/`mtmux approve` channels carry on alone.
  askInApp = relay.askDeviceApproval ?? null;
  connectedCount = relay.connectionSummary
    ? () => relay.connectionSummary!().count
    : null;

  const recordControl = createRecordControl({
    authToken: cfg.token,
    ...(relay.recorder && relay.recordings
      ? {
          recorder: {
            list: relay.recordings.list,
            start: relay.recorder.start,
            stop: (id: string) => relay.recorder!.stop(id, "requested"),
            stopAll: () => relay.recorder!.stopAll("requested"),
            remove: relay.recordings.remove,
          },
        }
      : {}),
  });

  const devicesControl = createDevicesControl({
    authToken: cfg.token,
    summary: relay.connectionSummary,
    ...(relay.revokeSessionToken
      ? { revokeToken: relay.revokeSessionToken }
      : {}),
  });

  /*
   * Restore the devices we already trust *before* anything can connect.
   *
   * `registerDirectToken` reaches the relay over loopback HTTP, so doing this
   * after `serve` left a window — seconds, with several peers and a 3s timeout
   * each — in which a returning phone authenticated against a relay that had
   * not been told about it yet. The browser treats `auth:failure` as terminal:
   * it clears the stored token and navigates to `/start`, so the user is asked
   * to pair again for what was a startup ordering bug. Registering in-process
   * needs no listener and closes the window entirely.
   */
  const registerInProcess = relay.registerSessionToken;
  const restoreEarly: typeof registerDirectToken | null = registerInProcess
    ? async (
        _port,
        _authToken,
        directToken,
        grant,
        notice,
        ttlMs,
        deviceId,
      ) => {
        registerInProcess(
          directToken,
          ttlMs,
          undefined,
          grant,
          notice?.label,
          deviceId,
        );
        return true;
      }
    : null;
  const earlyRestore = restoreEarly
    ? await restoreTrustedDevices(opts.port, cfg.token, restoreEarly)
    : null;

  const { shutdown: stopServing } = await serve({
    relay,
    requestHandler: app.getRequestHandler(),
    port: opts.port,
    host,
    portHintCommand: "mtmux start",
    controlHandler: async (req, res) =>
      (await approveControl.handle(req, res)) ||
      (await devicesControl.handle(req, res)) ||
      (await recordControl.handle(req, res)),
  });

  const localUrl = `http://localhost:${opts.port}`;
  const lanUrl = resolveLanUrl(host, opts.port, lan);

  // Only reached with a bundle that predates `registerSessionToken`, which
  // still has to go over HTTP and so still has to wait for the listener.
  const { restored, needRepair, needRekey, trusted } =
    earlyRestore ?? (await restoreTrustedDevices(opts.port, cfg.token));

  // Flags beat the stored setting, and `--trust-reconnect` beats
  // `--confirm-reconnect` if somebody passes both — the explicit "not now" is
  // the one you want to win when you are about to walk away from the machine.
  const confirmReconnect = opts.trustReconnect
    ? false
    : (opts.confirmReconnect ??
      (await configStore.getReconnectPolicy()) === "confirm");

  const confirmReturning = confirmReconnect ? makeReturningGate() : undefined;

  // Tokenless LAN sign-in only makes sense for a *different* device, so the
  // nonce is armed exactly when there is an address such a device could reach.
  const armLanNonce = () =>
    lanUrl
      ? `${lanUrl}/login#n=${relay.issuePairingNonce(PAIRING_NONCE_TTL_MS).nonce}`
      : null;

  let hosted: Hosted | null = null;
  let note: string | null = null;
  /**
   * Set by `shutdown()` below, and read by anything that can still fire after
   * it — the late tunnel above all, which can arrive minutes after Ctrl-C.
   */
  let shuttingDown = false;
  /** Stops the tunnel agent even when hosting never finished. */
  let stopAgent: (() => void) | null = null;

  const lanInterface = WILDCARD.has(host) ? (lan?.iface ?? null) : null;

  const record = (inviteUrl: string | null): serverState.ServerState => ({
    pid: process.pid,
    port: opts.port,
    host,
    localUrl,
    lanUrl,
    mode: hosted ? "tunnel" : "local",
    inviteUrl,
    startedAt: Date.now(),
    version,
  });

  const reprint = (invite: PairingInvite) => {
    waitingLineOnScreen = true;
    for (const line of renderBannerLines({
      version,
      localUrl,
      lanUrl,
      lanInterface,
      invite,
      showQr: opts.qr,
      token: cfg.token,
      note,
    })) {
      console.log(line);
    }
  };

  // Resolved once, before any code is armed, so a typo in --share is a clean
  // refusal rather than a code that turns out to grant nothing.
  let shareSessions: GrantSession[] | null = null;
  if (opts.share) {
    try {
      shareSessions = await resolveShareSessions(
        opts.port,
        cfg.token,
        opts.share,
      );
    } catch (err) {
      console.error(kleur.red(`  ✗ ${(err as Error).message}`));
      await stopServing();
      process.exitCode = 1;
      return;
    }
  }

  const buildGrant = shareSessions
    ? (directToken: string): GrantRecord => ({
        id: grantsStore.newGrantId(),
        label: `start --share ${opts.share ?? ""}`.trim(),
        scope: { kind: "sessions", sessions: shareSessions },
        readOnly: opts.shareReadOnly === true,
        files: opts.shareFiles ?? "none",
        createdAt: Date.now(),
        expiresAt: null,
        revokedAt: null,
        tmuxServerPid: null,
        tokenHash: grantsStore.hashToken(directToken),
      })
    : undefined;

  if (shareSessions && !opts.json) {
    for (const line of shareBanner({
      id: "grn_preview",
      label: "",
      scope: { kind: "sessions", sessions: shareSessions },
      readOnly: opts.shareReadOnly === true,
      files: opts.shareFiles ?? "none",
      createdAt: Date.now(),
      expiresAt: null,
      revokedAt: null,
      tmuxServerPid: null,
      tokenHash: "0".repeat(64),
    })) {
      console.log(line);
    }
  }

  /**
   * Wait for a keypress, then mint one more code.
   *
   * Only ever armed after `onIdle`, so the common path never touches stdin. A
   * non-interactive process — a service unit, a CI run — has nobody to press
   * anything, so it simply stops arming, which is the safe direction: the whole
   * point is that an unwatched terminal stops issuing draws at the secret.
   */
  const waitForRearm = () => {
    if (!process.stdin.isTTY) return;
    process.stdin.resume();
    process.stdin.once("data", () => {
      process.stdin.pause();
      void hosted
        ?.rearm()
        .then((invite) => {
          reprint(invite);
          void serverState.write(record(invite.url)).catch(() => {});
        })
        .catch(() => {});
    });
  };

  if (!opts.local) {
    try {
      hosted = await startHosted({
        buildGrant,
        port: opts.port,
        base,
        cfg,
        tunnelOnly: false,
        trusted,
        confirmReturning,
        onPaired: (label) => {
          // Redrawn, not appended. The banner's last line still says "Waiting
          // for a device…", and printing underneath it leaves a stale claim on
          // screen above the news that it is no longer true.
          clearWaitingLine();
          // "Paired", not "connected". The socket authenticating is what
          // connected means, and `onConnectionsChanged` says so a moment later
          // — claiming it here too printed the same news twice.
          console.log(kleur.green(`  ✓ Paired with ${label}.`));
          console.log(
            kleur.dim(`    It has the terminal at ${lanUrl ?? localUrl}.`),
          );
          console.log(
            kleur.dim(
              "    It stays paired across restarts — mtmux devices lists it.",
            ),
          );
          console.log("");
        },
        onWarn: (notice) => {
          clearWaitingLine();
          if (notice.warning === "broker-misbehaving") {
            console.log(
              kleur.red(
                "  ! The pairing service offered more terminals than it should.",
              ),
            );
            console.log(
              kleur.dim(
                "    Stopped arming rather than risk pairing with the wrong one.",
              ),
            );
            return;
          }
          // Under four, the likeliest reading is a fumble on a phone keyboard,
          // and saying anything heavier would be crying wolf at a typo.
          if (notice.warning === "wrong-code") {
            console.log(
              kleur.yellow(
                "  ! Someone entered a wrong code. That one is now dead.",
              ),
            );
            console.log(
              kleur.dim("    Here's a fresh one — the old code will not work."),
            );
            return;
          }
          // From the fourth, a stranger is likelier than a fumble. Say so, and
          // name the delay so the pause reads as deliberate rather than broken.
          console.log(
            kleur.yellow(
              `  ! Wrong code again (${notice.wrong}). If that wasn't you, someone is guessing.`,
            ),
          );
          console.log(
            kleur.dim(
              `    Slowing down — next code in ${Math.round(notice.delayMs / 1000)}s.`,
            ),
          );
        },
        onRearm: (invite, reason) => {
          console.log(kleur.dim(`    ${REARM_LINES[reason]}`));
          reprint(invite);
          void serverState.write(record(invite.url)).catch(() => {});
        },
        onIdle: () => {
          clearWaitingLine();
          console.log(
            kleur.dim(
              "    No one used the last few codes, so I've stopped making them.",
            ),
          );
          console.log(kleur.dim("    Press enter for a new code."));
          waitForRearm();
        },
        onAgent: (stop) => {
          stopAgent = stop;
        },
        onLateTunnel: (late) => {
          /*
           * The user may have given up and pressed Ctrl-C while we were still
           * retrying. Arming two pairing mailboxes, printing a live code and
           * rewriting the state file for a machine they believe is stopped is
           * worse than doing nothing — and the `serverState.write` below would
           * race the `clear()` in `shutdown`, leaving a state file pointing at
           * a dead pid.
           */
          if (shuttingDown) {
            late.stop();
            return;
          }
          // The banner has already been printed, saying the machine is serving
          // locally. Correct that rather than leaving a stale claim on screen.
          hosted = late;
          note = null;
          void serverState.write(record(late.invite.url)).catch(() => {});
          // `--json` printed one object and is being read by a script, not a
          // person. Emitting a banner into it now would corrupt that output.
          if (opts.json) return;
          clearWaitingLine();
          console.log(kleur.green("  ✓ The tunnel came up."));
          console.log(
            kleur.dim("    Here's a code for pairing a device anywhere:"),
          );
          reprint(late.invite);
        },
      });
    } catch (err) {
      // The tunnel is a convenience, not a dependency. An offline machine, a
      // blocked outbound connection or a broker outage must all land here and
      // leave a working LAN server behind — this is what keeps `mtmux start`
      // identical to its self-hosted behaviour when our servers are absent.
      note =
        `Tunnel unavailable (${(err as Error).message}). ` +
        `Serving locally — retry later or use --local to skip this.`;
    }
  }

  const lanQrPayload = hosted ? null : armLanNonce();

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          version,
          localUrl,
          lanUrl,
          mode: hosted ? "tunnel" : "local",
          code: hosted?.invite.code ?? null,
          joinUrl: hosted?.invite.url ?? null,
          trustedDevices: restored,
          connectedDevices: relay.connectionSummary?.().count ?? 0,
          token: cfg.token,
          note,
        },
        null,
        2,
      ),
    );
  } else {
    waitingLineOnScreen = hosted !== null;
    banner({
      version,
      localUrl,
      lanUrl,
      lanInterface,
      invite: hosted?.invite ?? null,
      lanQrPayload,
      showQr: opts.qr,
      token: cfg.token,
      note,
    });
  }

  if ((restored > 0 || needRepair > 0 || needRekey > 0) && !opts.json) {
    // Printed under the banner, so the "Waiting…" line is no longer the bottom
    // of the screen and must not be erased later.
    waitingLineOnScreen = false;
  }

  if (restored > 0 && !opts.json) {
    console.log(
      kleur.dim(
        `  ${restored} device${restored === 1 ? "" : "s"} already trusted — ` +
          `${restored === 1 ? "it does" : "they do"} not need the code.`,
      ),
    );
    console.log("");
  }

  if (needRekey > 0 && !opts.json) {
    // Deliberately not folded into `needRepair`: these devices are not broken,
    // they are reachable on this network and nowhere else. Saying "pair again"
    // to someone whose phone is working fine on the sofa reads as a lie.
    console.log(
      kleur.yellow(
        `  ${needRekey} device${needRekey === 1 ? "" : "s"} can reach this machine on the local network only.`,
      ),
    );
    console.log(
      kleur.dim(
        `    ${needRekey === 1 ? "It was" : "They were"} paired before mtmux could restore a tunnel across restarts.`,
      ),
    );
    console.log(kleur.dim("    Pair again, once, to reach it from anywhere."));
    console.log("");
  }

  if (needRepair > 0 && !opts.json) {
    // Said plainly rather than left to fail as a mysterious auth error the
    // next time someone opens the tab on that device.
    console.log(
      kleur.yellow(
        `  ${needRepair} device${needRepair === 1 ? "" : "s"} need${needRepair === 1 ? "s" : ""} to pair again (one-time).`,
      ),
    );
    console.log(
      kleur.dim("    They were paired before mtmux stored a per-device token."),
    );
    console.log("");
  }

  if (!opts.json) {
    const notice = describeUpdate(version, await updateCheck);
    if (notice.kind !== "current" || notice.advisory) {
      // Under the banner, so the "Waiting…" line is no longer the bottom of
      // the screen and must not be erased when a device pairs.
      waitingLineOnScreen = false;
      const colour = notice.kind === "outdated" ? kleur.yellow : kleur.dim;
      if (notice.kind !== "current") {
        console.log(colour(`  mtmux ${notice.detail}`));
        if (notice.fix) console.log(kleur.dim(`    ${notice.fix}`));
      }
      // The operator's own words, printed verbatim and last. This is the only
      // channel that reaches a running CLI without a release.
      if (notice.advisory) console.log(kleur.yellow(`  ${notice.advisory}`));
      console.log("");
    }
  }

  watchConnectedDevices(relay, opts.json === true);

  /*
   * Keep `lastSeenAt` honest.
   *
   * The relay is the only part of this process that sees a device
   * authenticate, and its session-token window has slid on every use since the
   * TTL fix. Without this the peer store never heard about any of it: a phone
   * used every day still showed its pairing date under "last seen" and was
   * expired by `mtmux devices` ninety days after it was first paired, while
   * the relay — whose window had been renewing all along — carried on letting
   * it in. Two stores, one rule, and only one of them could observe it.
   *
   * Throttled because this writes the config file. An hour's resolution is far
   * finer than a ninety-day window needs, and it means a reconnect storm costs
   * one write rather than one per attempt.
   */
  const TOUCH_INTERVAL_MS = 60 * 60 * 1000;
  const lastTouched = new Map<string, number>();
  relay.onSessionTokenUsed?.((deviceId) => {
    const now = Date.now();
    const previous = lastTouched.get(deviceId);
    if (previous !== undefined && now - previous < TOUCH_INTERVAL_MS) return;
    lastTouched.set(deviceId, now);
    void configStore.touchPeer(deviceId, now).catch(() => {
      // Bookkeeping on a file that may be read-only or full. Losing it costs
      // accuracy in `mtmux devices`, and must not cost the device its session.
    });
  });

  await serverState.write(record(hosted?.invite.url ?? null));

  // A LAN nonce is single-use, so once a phone has signed in the code on screen
  // is spent. Mint another and reprint rather than leaving a dead QR up.
  if (!hosted && lanUrl) {
    relay.onPairingRedeemed(() => {
      console.log(kleur.green("  ✓ Device signed in."));
      console.log(kleur.dim("    Here's a fresh code for the next one:"));
      for (const line of renderBannerLines({
        version,
        localUrl,
        lanUrl,
        lanInterface,
        lanQrPayload: armLanNonce(),
        showQr: opts.qr,
        token: cfg.token,
      })) {
        console.log(line);
      }
    });
  }

  const { key } = await configStore.ensureDeviceKey();
  const stopHeartbeat = await registerWithAccount(
    base,
    opts.name ?? cfg.serverName ?? os.hostname(),
    Buffer.from(key.publicKey).toString("hex"),
  );
  if (opts.name) await configStore.setServerName(opts.name);

  if (opts.open) {
    // Auto-open with the token in the URL *fragment* (never the query): the
    // fragment is never sent to the server or logged, and the login page reads
    // it on mount to auto-authenticate — no manual copy-paste.
    const openUrl = `${localUrl}/login#token=${encodeURIComponent(cfg.token)}`;
    await openBrowser(openUrl).catch(() => {});
  }

  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log("\n  Stopping…");
    stopHeartbeat?.();
    stopMirror?.();
    approveControl.close();
    hosted?.stop();
    // `hosted` is null on the late-tunnel path — hosting threw and the agent
    // was deliberately left retrying — so without this its backoff loop and
    // its open broker socket survive Ctrl-C and hold the process up.
    stopAgent?.();
    void serverState.clear();
    stopServing();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
