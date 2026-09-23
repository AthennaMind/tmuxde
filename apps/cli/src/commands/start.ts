import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import kleur from "kleur";
import openBrowser from "open";
import * as configStore from "../config-store.js";
import * as grantsStore from "../grants-store.js";
import * as serverState from "../server-state.js";
import {
  banner,
  renderBannerLines,
  renderCodeUpdateLines,
  type PairingInvite,
} from "../banner.js";
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
  generateLocalCode,
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
import {
  decideAccess,
  transportText,
  promptForAccess,
  type AccessPromptInput,
  type AccessPromptResult,
} from "../access-prompt.js";
import {
  createDevicePanel,
  type DevicePanel,
} from "../device-panel-control.js";
import type { PanelPeer } from "../device-panel.js";
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

/**
 * The banner outlives the terminal scrollback; keep the local offer alive as
 * long.
 *
 * A day, not fifteen minutes, and the reason is what `mtmux start` is for: it
 * is left running. Somebody who starts it in the morning and picks up a tablet
 * after lunch should not find the digits on their own screen have quietly
 * stopped meaning anything. The bound that matters is not the clock — it is
 * that the offer is single-use, survives only five wrong guesses, and buys
 * nothing without a human saying yes.
 */
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
  /**
   * `true` for an explicit `--local`; `undefined` means the stored `reach`
   * setting decides. Resolved once, early, into `localOnly`.
   */
  local?: boolean;
  /** An explicit `--hosted`, which beats the stored setting but not `--local`. */
  hosted?: boolean;
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
      req: {
        sas?: string;
        deviceLabel: string;
        accountEmail: string;
        via?: "code" | "request" | "returning";
      },
      opts: { signal: AbortSignal },
    ) => Promise<boolean | null>)
  | null = null;

/**
 * Where everything this command prints goes.
 *
 * A module-level indirection rather than 74 call sites passing a logger
 * around, and a mutable one because the live panel cannot exist until the
 * relay does — the banner is printed before there is anything to panel. Until
 * then this is `console.log` exactly as it was, which is also what it stays as
 * under `--json`, in a pipe, and in a service unit.
 *
 * The reason it has to be *one* thing is the reason `watchConnectedDevices`
 * gave for staying append-only: "a second writer moving the cursor would
 * corrupt the QR the moment the two coincided". That is still true. The panel
 * does not make it safe to have two writers; it makes there be one.
 */
let screen: { log: (...lines: string[]) => void } = {
  log: (...lines) => {
    if (lines.length === 0) console.log("");
    else for (const line of lines) console.log(line);
  },
};

function say(...lines: string[]): void {
  screen.log(...lines);
}

/** The live panel, once the relay exists. Null when it declined to start. */
let panel: DevicePanel | null = null;

/**
 * The owner's own name for a device, once the peer cache exists.
 *
 * A holder rather than a direct read, because the connection gate is installed
 * before the port is bound and the cache is built after — so for a few hundred
 * milliseconds of boot there is a real device that can connect and no list to
 * look it up in. Answering "no name yet" there is right; throwing a reference
 * error into a security gate that reads a throw as a refusal is not.
 */
let peerNameFor: (deviceId: string) => string | null = () => null;

/**
 * The gate every socket passes, once the relay exists.
 *
 * Module-level for the same reason `approvals` and `askInApp` are: the tunnel
 * agent that closes over `admitStream` is built before the relay bundle is
 * imported, and the two halves of one decision must not end up as two
 * different decisions. Sharing the one gate is what makes the tunnel's own
 * check and the relay's check a single question with a single answer.
 */
let connectionGate: ConnectionGate | null = null;

/**
 * Fires the moment the panel takes stdin, so no readline can outlive it.
 *
 * There is a window between the tunnel arming a code and the panel appearing
 * below the banner. A pairing landing in it is answered by the readline
 * prompt, because there is no panel yet to ask in — and then the panel starts,
 * puts the terminal in raw mode and installs its own reader, and there are two
 * readers on one stdin. That is the exact defect `access-prompt.ts`'s header
 * records paying for once already: "a dead `[y/N]` eating keystrokes on the
 * machine".
 *
 * So the readline is bound to this as well as to its own question's signal.
 * When the panel starts, any prompt still standing is taken down and reports
 * "could not ask" — never a refusal — which sends the question on to `park`,
 * and the terminal says how to answer it. A question that moves is recoverable;
 * a terminal with two readers is not.
 */
const stdinTakeover = new AbortController();

/**
 * Ask on the machine, through whatever owns stdin at the time.
 *
 * Resolved per call rather than captured, because which of the two it is
 * changes exactly once, part-way through start-up, and the wrong answer in
 * either direction is a bug: the panel's seam before the panel exists is a
 * question drawn nowhere, and the readline after it is a second reader.
 */
function askOnThisMachine(
  req: AccessPromptInput,
  signal: AbortSignal,
): Promise<AccessPromptResult> {
  if (panel?.enabled) return panel.promptForAccess(req, signal);
  return promptForAccess(req, {
    signal: AbortSignal.any([signal, stdinTakeover.signal]),
  });
}

/** How many devices are connected right now, for what the parked notice says. */
let connectedCount: (() => number) | null = null;

/**
 * The gate on a code pairing, which until now had none.
 *
 * The old rule was that typing the code *was* the approval: you ran the
 * command, you were standing there, the code was fresh. The flaw is that the
 * code is read off a screen and typed somewhere else, so what it proves is
 * that somebody saw the screen — a shoulder, a shared desk, a screenshot in a
 * chat — and not that the person holding the browser is you. Knowledge of the
 * code and consent to the pairing had been treated as the same fact.
 *
 * So the same three channels that decide a dashboard request decide this one:
 * the app on a phone already connected, the TTY, and `mtmux approve`. Silence
 * denies, as everywhere else. There are no digits to compare — the code was
 * the shared secret — so the question is "did you just type this?", not "do
 * these match?", and `renderAccessRequest` switches on the absent SAS.
 *
 * Refusal is not a failure: the keys are simply never admitted and the round
 * re-arms, so a mistyped-by-a-stranger code costs nothing but a new code.
 */
async function confirmCodePairing(label: string): Promise<boolean> {
  const req: AccessPromptInput = {
    deviceLabel: label,
    accountEmail: "",
    via: "code",
  };
  clearWaitingLine();
  const answer = await decideAccess(req, {
    ask: askInApp ? (r, signal) => askInApp!(r, { signal }) : undefined,
    offer: approvals ? (r) => approvals!.offer(r) : undefined,
    // Whichever of the two owns stdin right now — see `askOnThisMachine`.
    prompt: askOnThisMachine,
    park: approvals
      ? (r, signal) =>
          approvals!.offer(r, { park: true, signal }).then((v) => v === true)
      : undefined,
    onParked: (r) => {
      clearWaitingLine();
      say("");
      say(kleur.bold("  A device just entered this machine's pairing code"));
      say("");
      say(
        `    ${kleur.dim("Device ")}  ${displayLabel(r.deviceLabel, "unknown device")}`,
      );
      say("");
      const asked = connectedCount?.() ?? 0;
      say(
        kleur.dim(
          asked > 0
            ? `    Asked the ${asked === 1 ? "device" : `${asked} devices`} already connected — answer there,`
            : "    Nothing is attached to this terminal, so I cannot ask here.",
        ),
      );
      say(
        kleur.dim(asked > 0 ? "    or run " : "    Run ") +
          kleur.bold("mtmux approve") +
          kleur.dim(" in another shell."),
      );
      say("");
    },
  });
  if (!answer.approved) {
    clearWaitingLine();
    say(
      kleur.yellow(
        `  ✗ Refused ${displayLabel(label, "that device")}. Nothing was shared.`,
      ),
    );
  }
  return answer.approved;
}

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
        // See `askOnThisMachine`: whichever of the two owns stdin right now.
        prompt: askOnThisMachine,
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
          say("");
          say(kleur.bold("  A browser wants to pair with this machine"));
          say("");
          say(
            `    ${kleur.dim("Device ")}  ${displayLabel(req.deviceLabel, "unknown device")}`,
          );
          say(
            `    ${kleur.dim("Account")}  ${displayLabel(req.accountEmail, "unknown account")}`,
          );
          if (req.sas) {
            say(
              `    ${kleur.dim("Code   ")}  ${kleur.bold(formatSas(req.sas))}`,
            );
          }
          say("");
          // Two different true things to say, and saying the wrong one is how
          // a security prompt teaches people to ignore it. "I cannot ask here"
          // is false the moment a phone is showing the dialog.
          const asked = connectedCount?.() ?? 0;
          if (asked > 0) {
            say(
              kleur.dim(
                `    Asked the ${asked === 1 ? "device" : `${asked} devices`} already connected — answer there,`,
              ),
            );
            say(
              kleur.dim("    or run ") +
                kleur.bold("mtmux approve") +
                kleur.dim(" in another shell. Either way, compare the code."),
            );
          } else {
            say(
              kleur.dim(
                "    Nothing is attached to this terminal, so I cannot ask here.",
              ),
            );
            say(
              kleur.dim("    Run ") +
                kleur.bold("mtmux approve") +
                kleur.dim(" in another shell, then compare the code."),
            );
          }
          say("");
        },
      });
      if (!answer.approved) {
        // Logged locally so a refusal leaves a trace on the machine that
        // refused it. The broker is told nothing beyond "denied".
        say(
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
        say(
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
      // The human just said yes to this device. The socket it opens a moment
      // from now is that same yes arriving, not a new question.
      connectionGate?.approve(deviceId);
      await configStore.addPeer({
        deviceId,
        publicKey: "",
        label: request.deviceLabel,
        pairedAt: Date.now(),
        lastSeenAt: Date.now(),
        directToken: request.keys.directToken,
        sessionKeys: encodeSessionKeys(request.keys),
      });
      say(
        kleur.green(
          `  ✓ ${displayLabel(request.deviceLabel, "A device")} connected.`,
        ),
      );

      return { approved: true, sealedDescriptor: bytesToBase64Url(sealed) };
    },
    onStreamBound: (peer) => {
      if (peer?.restored) opts.onReturned?.(peer);
    },
    /*
     * Every stream, not only the ones restored from disk.
     *
     * The old rule here was "a device that paired in this process was approved
     * seconds ago, so do not ask again" — which is true of the first stream
     * and false of every one after it, and those later streams are the whole
     * of the problem: a browser that paired once could come back through the
     * tunnel from any network, at any hour, in silence.
     *
     * Asking twice about one act is still wrong, and it is not what happens:
     * the pairing seeds `connectionGate.approve` with the device it just
     * admitted, and the shared answer covers the connection that follows. See
     * `makeConnectionGate`.
     */
    admitStream: async (peer) => {
      if (!peer || !connectionGate) return true;
      return connectionGate.admit({
        tokenId: null,
        deviceId: peer.deviceId,
        label: peer.label,
        transport: "tunnel",
        userAgent: null,
      });
    },
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
      // The yes/no on a typed or scanned code, asked before the browser is
      // told anything. See `admit` in `pairing-exchange.ts` for why it cannot
      // live in the `paired` handler below.
      admit: confirmCodePairing,
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
            say(
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
          connectionGate?.approve(peerDeviceId);
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
                say(
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
  // Once the panel is up it owns the cursor, and a second escape sequence
  // walking up two rows would erase the top of its table. The panel clears
  // the flag when it starts, so this is belt and braces for a caller holding
  // a stale `true` across that moment.
  if (panel?.enabled) return;
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
      say(kleur.green(`  ✓ ${label} connected.`));
    }
    for (const label of departed) {
      say(kleur.dim(`  · ${label} disconnected.`));
    }
    // The running total, for the readers that have no other way to know it.
    // The panel draws it in its headline and redraws it as it changes, so
    // printing it again is the same number twice on one screen — and it was
    // the line that made three phones reconnecting at boot look like nine
    // events. A pipe, a service unit or a short terminal has no panel and
    // still needs the count.
    if (!panel?.enabled) {
      say(kleur.dim(`    ${devicesOnline(current.length)}`));
      say("");
    }
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
 * How long one approval covers a device after its last socket goes away.
 *
 * The gate below asks about *connections*, not credentials, and a browser is
 * not one connection: it opens a socket per tab, races several candidates on
 * every sign-in, and drops and remakes the lot whenever a phone changes cell.
 * Asking about each of those literally would be a prompt every few minutes on
 * a device the owner is actively using — which is not security, it is a
 * doorbell nobody answers any more.
 *
 * So an approval covers a device for as long as it stays connected, and for
 * two minutes after the last of its sockets closes. That window is chosen
 * against the thing being defended: somebody holding a copied credential can
 * only use it silently inside a window the real device opened seconds ago and
 * is about to reuse. Close the laptop, walk away, come back — and the machine
 * asks again.
 */
const ADMIT_GRACE_MS = 120_000;

/** A refusal stands this long, so a rejected device cannot ring the bell again. */
const REFUSAL_GRACE_MS = 15_000;

/** What the relay hands the gate about a socket that has just authenticated. */
type ConnectionRequest = {
  tokenId: string | null;
  deviceId: string | null;
  label: string | null;
  transport: "loopback" | "lan" | "tunnel";
  userAgent: string | null;
};

export type ConnectionGate = {
  /** The relay's seam: may this socket in? */
  admit: (req: ConnectionRequest) => Promise<boolean>;
  /**
   * Record that this device was just approved by a human, so the connection
   * it is about to open is not a second question about the same act.
   */
  approve: (deviceId: string) => void;
};

/**
 * The question asked of every socket, and the reason it is asked at all.
 *
 * Approval used to happen once per *credential*: you typed the code, somebody
 * said yes, and from then on that browser came and went as it pleased — from
 * any network, through the tunnel, at any hour, silently. Every release before
 * this one behaved that way, and it is the wrong model for the thing being
 * protected. A credential is a file on somebody else's computer. That it
 * paired once is a fact about the past; whether the person holding it now is
 * the owner is the question, and it can only be asked now.
 *
 * So this sits on `wire-connections.ts`'s one choke point — a socket that has
 * authenticated and has been told nothing yet — and every path crosses it:
 * loopback, LAN, and the sealed tunnel alike. It is deliberately *not* on the
 * tunnel agent, which is where the old gate lived and why it only ever covered
 * a third of the cases.
 *
 * Answers are shared by device rather than by socket. Concurrent sockets from
 * one browser — tabs, the candidate race, a reconnect storm — collapse into a
 * single question, and see `ADMIT_GRACE_MS` for how long that answer lasts.
 */
export function makeConnectionGate(deps: {
  /** Whether a device that already paired is asked about when it connects. */
  asks: () => boolean;
  /** Device ids with a live socket right now. */
  connected: () => string[];
  /** The owner's name for a device, when they have given it one. */
  nameFor?: (deviceId: string) => string | null;
  /**
   * Put the question to a human. Defaults to the full `decideAccess` race —
   * the app on a connected phone, this terminal, `mtmux approve` — and is
   * injectable so the caching rules above can be tested without a tty.
   */
  ask?: (req: ConnectionRequest, named: string) => Promise<boolean>;
}): ConnectionGate {
  const decided = new Map<
    string,
    { answer: Promise<boolean>; until: number; approved: boolean }
  >();

  const keyFor = (req: ConnectionRequest): string =>
    req.deviceId ?? (req.tokenId ? `token:${req.tokenId}` : "machine-token");

  const covered = (key: string, deviceId: string | null): boolean => {
    const record = decided.get(key);
    if (!record) return false;
    const live = deviceId !== null && deps.connected().includes(deviceId);
    if (record.approved && live) {
      // Still on screen somewhere. Keep the cover alive rather than letting it
      // lapse under a device that never went away.
      record.until = Date.now() + ADMIT_GRACE_MS;
      return true;
    }
    if (Date.now() < record.until) return true;
    decided.delete(key);
    return false;
  };

  return {
    approve(deviceId) {
      decided.set(deviceId, {
        answer: Promise.resolve(true),
        until: Date.now() + ADMIT_GRACE_MS,
        approved: true,
      });
    },

    admit(req) {
      const key = keyFor(req);
      if (covered(key, req.deviceId)) return decided.get(key)!.answer;
      // The policy is read now, not captured: `a` in the live panel flips it
      // without a restart, and a gate holding the value it booted with would
      // be the one control on this panel that quietly does nothing.
      if (!deps.asks()) return Promise.resolve(true);

      const named =
        (req.deviceId ? deps.nameFor?.(req.deviceId) : null) ||
        req.label ||
        "An unnamed device";

      const asking = deps.ask
        ? deps.ask(req, named)
        : (async () => {
            clearWaitingLine();
            const answer = await decideAccess(
              {
                deviceLabel: named,
                accountEmail: "",
                via: "returning",
                transport: req.transport,
              },
              {
                ask: askInApp
                  ? (r, signal) => askInApp!(r, { signal })
                  : undefined,
                offer: approvals ? (r) => approvals!.offer(r) : undefined,
                prompt: askOnThisMachine,
                park: approvals
                  ? (r, signal) =>
                      approvals!
                        .offer(r, { park: true, signal })
                        .then((v) => v === true)
                  : undefined,
                onParked: (r) => {
                  clearWaitingLine();
                  say("");
                  say(kleur.bold("  A device you know is connecting"));
                  say("");
                  say(`    ${kleur.dim("Device ")}  ${r.deviceLabel}`);
                  const where = transportText(req.transport);
                  if (where) say(`    ${kleur.dim("Coming ")}  ${where}`);
                  say("");
                  say(
                    kleur.dim("    Run ") +
                      kleur.bold("mtmux approve") +
                      kleur.dim(" in another shell to let it in."),
                  );
                  say("");
                },
              },
            );
            if (answer.approved) {
              say(kleur.green(`  ✓ ${named} let in.`));
              return true;
            }
            if (answer.reason === "no-tty") {
              // Refusing *is* the setting applying. Admitting because nobody could
              // be asked would be the setting quietly not applying, which is the
              // worst outcome available for a control somebody turned on.
              say(
                kleur.yellow(`  ! Refused ${named}: nothing here to ask on.`),
              );
              say(
                kleur.dim("    Start with ") +
                  kleur.bold("--trust-reconnect") +
                  kleur.dim(", or ") +
                  kleur.bold("mtmux config set reconnectPolicy trust") +
                  kleur.dim("."),
              );
            } else {
              say(kleur.yellow(`  ✗ Refused ${named}. Nothing was shared.`));
            }
            return false;
          })();

      // Held with an open-ended window while the question stands, so every
      // other socket that arrives meanwhile waits on this one answer instead
      // of raising a second copy of it.
      const record = {
        answer: asking,
        until: Number.POSITIVE_INFINITY,
        approved: false,
      };
      decided.set(key, record);
      void asking.then(
        (ok) => {
          record.approved = ok;
          record.until = Date.now() + (ok ? ADMIT_GRACE_MS : REFUSAL_GRACE_MS);
        },
        () => decided.delete(key),
      );
      return asking;
    },
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
      say(kleur.yellow(`  ! ${result.reason}`));
      if (result.upgradeUrl) {
        say(kleur.dim(`    ${result.upgradeUrl}`));
      }
      return null;
    }
    if (result.trialStarted) {
      // The most important line of copy in this feature. What someone hits
      // here used to be a 402 telling them to get out a card; it is now this.
      say(
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
  /**
   * How far this run reaches, resolved once so nothing downstream has to know
   * the precedence.
   *
   * `--local` first, because an explicit "not now" must beat a preference set
   * weeks ago. Then `--hosted`. Then the stored setting. Then the default,
   * which is local.
   */
  const localOnly = opts.local
    ? true
    : opts.hosted
      ? false
      : (await configStore.getReach()) !== "hosted";

  /**
   * Whether `t` is a real offer on this run, and therefore worth printing.
   *
   * Only when this run was local *by default*. Someone who typed `--local` has
   * made this decision and does not need it explained, and a run where the
   * tunnel was asked for and failed has `note` saying what happened — the key
   * is live in both cases, it is just not advertised.
   */
  const offersTunnel = localOnly && !opts.local;

  const updateCheck =
    localOnly || opts.json
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

  /*
   * The reconnect policy, resolved before anything can connect.
   *
   * It has to be: the gate below is installed before `serve` binds the port,
   * and a gate that read a value initialised later would be a gate with a hole
   * in it exactly during boot — the window a device racing the restore lands
   * in. Flags beat the stored setting, and `--trust-reconnect` beats
   * `--confirm-reconnect` if somebody passes both: the explicit "not now" is
   * the one you want to win when you are about to walk away from the machine.
   */
  let askOnReconnect = opts.trustReconnect
    ? false
    : (opts.confirmReconnect ??
      (await configStore.getReconnectPolicy(process.stdout.isTTY === true)) ===
        "confirm");

  /*
   * Read at the moment a device connects, not captured at boot, so `a` in the
   * live panel flips it without a restart. A setting you have to stop the
   * server to change is a setting nobody changes, and this is exactly the one
   * people want on when they walk away from the machine and off when they are
   * sitting in front of it.
   */
  connectionGate = makeConnectionGate({
    asks: () => askOnReconnect,
    connected: () =>
      (relay.connectionDetails?.() ?? [])
        .map((device) => device.deviceId)
        .filter((id): id is string => typeof id === "string"),
    nameFor: (deviceId) => peerNameFor(deviceId),
  });
  relay.setConnectionGate?.((req) => connectionGate!.admit(req));

  /*
   * The local path gets the same gate as every other one, and until now it had
   * none at all.
   *
   * Scanning the QR on your own wifi minted a full-grant session token with no
   * question asked anywhere — on the reasoning that being on the network was
   * itself the proof. It is not. A network is not a person: a housemate, a
   * guest, a laptop somebody else left on the wifi, anyone who can see the
   * screen through a window. That is the *same* argument `confirmCodePairing`
   * above makes about the nine-digit code, and it does not stop being true
   * because the packets took a shorter route.
   *
   * So the relay asks before it answers, through the identical race — the app
   * on a connected phone, the TTY or the live panel, `mtmux approve` — and
   * silence denies. Wired here because this is where the relay runtime first
   * exists; `pairing-local.ts` treats an uninstalled gate as an approval, so
   * installing it late would leave a window, and there is none: nothing is
   * listening on the port yet.
   */
  relay.setLocalPairingGate?.(async (req) => {
    const allowed = await confirmCodePairing(req.label);
    // The pairing approval covers the socket it was granted for. Without this
    // the browser is asked again the instant it connects — the same question,
    // thirty milliseconds later, which is how a product teaches people to hit
    // yes without reading.
    if (allowed && req.deviceId) connectionGate?.approve(req.deviceId);
    return allowed;
  });
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

  /**
   * Arm the local invite: a QR to scan and six digits to type.
   *
   * ## Why this is no longer conditional on there being a LAN
   *
   * It used to arm only when `lanUrl` existed, on the reasoning that tokenless
   * sign-in "only makes sense for a *different* device". That is true of the
   * QR — nobody scans their own screen — and it was quietly applied to the
   * whole credential, so a machine bound to loopback, a laptop with wifi off,
   * or anyone running `mtmux start` over SSH got a banner with no way in at
   * all except a 64-character token. The most common single-machine case had
   * the worst front door in the product.
   *
   * The digits do not need a second device. `http://localhost:PORT` is a real
   * address on a real browser, and typing six digits into it beats pasting
   * sixty-four every time. So the offer is always armed and the QR simply
   * points at the best address there is — the LAN one when it exists, because
   * that is the one a phone can reach, and loopback otherwise.
   */
  const localBase = () => lanUrl ?? localUrl;

  const armLocalInvite = (): PairingInvite => {
    const code = generateLocalCode();
    const { nonce } = relay.armLocalPairing(code, PAIRING_NONCE_TTL_MS);
    return {
      code,
      url: `${localBase()}/login#n=${nonce}`,
      host: localBase().replace(/^https?:\/\//, ""),
      reach: "local",
    };
  };

  /** The local invite currently on screen, re-armed whenever it is spent. */
  let localInvite: PairingInvite | null = null;

  /**
   * The tunnel is up: stop offering the short route nobody can read.
   *
   * A server that started local-only has six digits on its banner and an
   * offer armed for a day. Opening a tunnel replaces that banner with the
   * hosted one, and without this the local code stays live and claimable with
   * nothing anywhere displaying it — a printed secret that is no longer
   * printed, which is the one thing a printed secret must never become.
   *
   * Nothing is lost. A hosted pairing seals this machine's LAN candidates
   * into its descriptor, so a browser on this network still races straight to
   * a direct socket instead of going through the tunnel.
   */
  const dropLocalInvite = (): void => {
    if (!localInvite) return;
    localInvite = null;
    relay.disarmLocalPairing?.();
  };

  let hosted: Hosted | null = null;

  /**
   * What the tunnel is doing, for the one line on the panel that says so.
   *
   * `hosted` answers "is it up" and nothing else, so the twelve seconds it
   * spends registering at boot and the minutes it spends retrying after a
   * broker restart both read as "this machine is local-only" — which is false,
   * and about to be visibly false when a code appears. Undefined means this
   * run has no tunnel in its future at all, which is a third thing again.
   */
  let tunnelState: "connecting" | "up" | "retrying" | undefined;
  const tunnelPanelStatus = () => (hosted ? "up" : tunnelState);
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
      // Read at print time, not captured: `l` after pressing `t` must not
      // redraw an offer to do the thing that has already been done.
      canOpenTunnel: offersTunnel && hosted === null,
    })) {
      say(line);
    }
  };

  /**
   * The same news, at the size the news actually is.
   *
   * `reprint` is for a banner that has become wrong — a tunnel came up, the
   * reach changed, somebody pressed `l`. A code being spent does not make the
   * banner wrong; it makes one line of it wrong, and redrawing all of it to
   * fix that line is how the terminal ended up holding four QRs.
   */
  const reprintCode = (invite: PairingInvite) => {
    for (const line of renderCodeUpdateLines(invite, { showQr: opts.qr })) {
      say(line);
    }
    say("");
    // The panel carries the code too, and it does not repaint on its own
    // unless something on screen depends on the clock — so on an idle machine
    // it would keep showing the code that was just spent.
    panel?.refresh();
  };

  /** Whatever is currently claimable: the tunnel's invite, or the local one. */
  const liveInvite = (): PairingInvite | null =>
    hosted?.invite ?? localInvite ?? null;

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
      say(line);
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

  /**
   * Bring the tunnel up.
   *
   * Extracted from the `if (!localOnly)` block it used to be inlined in, for
   * one reason: a local-by-default start is now allowed to change its mind.
   * The banner's hint used to end at "run `mtmux start --hosted`", which means
   * stopping a server somebody may already have paired a phone to, and typing
   * a command to get back to where they were with one flag different. Pressing
   * a key does the same thing without the round trip through a dead server.
   *
   * Every callback below is the same on both paths, and that is the point of
   * the shape: the keypress route is not a second, thinner way to open a
   * tunnel, it is the same one started later.
   *
   * It returns the handle rather than assigning `hosted` itself, which is not
   * style. An assignment made only inside this closure is invisible to
   * TypeScript's flow analysis at every call site below, which narrows `hosted`
   * to `null` and then to `never` — so the compiler would reject `hosted.invite`
   * throughout a file where it is plainly reachable.
   */
  const openTunnel = async (): Promise<Hosted> => {
    tunnelState = "connecting";
    panel?.refresh();
    return startHosted({
      buildGrant,
      port: opts.port,
      base,
      cfg,
      tunnelOnly: false,
      trusted,
      onPaired: (label) => {
        // Redrawn, not appended. The banner's last line still says "Waiting
        // for a device…", and printing underneath it leaves a stale claim on
        // screen above the news that it is no longer true.
        clearWaitingLine();
        // "Paired", not "connected". The socket authenticating is what
        // connected means, and `onConnectionsChanged` says so a moment later
        // — claiming it here too printed the same news twice.
        //
        // One line, where there used to be four. The address it is served at
        // is two lines further up the screen and has not changed; that it
        // stays paired across restarts is true of every device and so says
        // nothing about this one. Both were printed again on every pairing.
        say(kleur.green(`  ✓ Paired with ${label}.`));
      },
      onWarn: (notice) => {
        clearWaitingLine();
        if (notice.warning === "broker-misbehaving") {
          say(
            kleur.red(
              "  ! The pairing service offered more terminals than it should.",
            ),
          );
          say(
            kleur.dim(
              "    Stopped arming rather than risk pairing with the wrong one.",
            ),
          );
          return;
        }
        // Under four, the likeliest reading is a fumble on a phone keyboard,
        // and saying anything heavier would be crying wolf at a typo.
        if (notice.warning === "wrong-code") {
          say(
            kleur.yellow(
              "  ! Someone entered a wrong code. That one is now dead.",
            ),
          );
          say(
            kleur.dim("    Here's a fresh one — the old code will not work."),
          );
          return;
        }
        // From the fourth, a stranger is likelier than a fumble. Say so, and
        // name the delay so the pause reads as deliberate rather than broken.
        say(
          kleur.yellow(
            `  ! Wrong code again (${notice.wrong}). If that wasn't you, someone is guessing.`,
          ),
        );
        say(
          kleur.dim(
            `    Slowing down — next code in ${Math.round(notice.delayMs / 1000)}s.`,
          ),
        );
      },
      onRearm: (invite, reason) => {
        // Only when something went wrong. "Here's a fresh code for the next
        // device" under a line that already says a device paired is a
        // sentence whose only content is that this program is still running.
        if (reason !== "paired") say(kleur.dim(`    ${REARM_LINES[reason]}`));
        reprintCode(invite);
        void serverState.write(record(invite.url)).catch(() => {});
      },
      onIdle: () => {
        clearWaitingLine();
        say(
          kleur.dim(
            "    No one used the last few codes, so I've stopped making them.",
          ),
        );
        say(kleur.dim("    Press enter for a new code."));
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
        tunnelState = "up";
        dropLocalInvite();
        note = null;
        void serverState.write(record(late.invite.url)).catch(() => {});
        // `--json` printed one object and is being read by a script, not a
        // person. Emitting a banner into it now would corrupt that output.
        if (opts.json) return;
        clearWaitingLine();
        say(kleur.green("  ✓ The tunnel came up."));
        say(kleur.dim("    Here's a code for pairing a device anywhere:"));
        reprint(late.invite);
      },
    });
  };

  if (!localOnly) {
    /*
     * Say what is happening while it happens.
     *
     * Registering with the broker and arming two mailboxes takes a few
     * seconds on a good connection and fifteen on a bad one, and until now the
     * terminal printed nothing at all for that whole stretch — so a machine
     * that was working looked identical to one that had hung, and `--hosted`
     * in particular looked like a flag that did nothing.
     */
    if (!opts.json) {
      say("");
      say(
        kleur.dim("  Opening a sealed tunnel… ") +
          kleur.dim(
            opts.hosted
              ? "(--hosted)"
              : "(mtmux config set reach local to skip)",
          ),
      );
    }
    try {
      hosted = await openTunnel();
      tunnelState = "up";
    } catch (err) {
      // The boot deadline passed. The agent is deliberately left retrying, so
      // "down" would be a third of the truth — the panel says which.
      tunnelState = "retrying";
      // The tunnel is a convenience, not a dependency. An offline machine, a
      // blocked outbound connection or a broker outage must all land here and
      // leave a working LAN server behind — this is what keeps `mtmux start`
      // identical to its self-hosted behaviour when our servers are absent.
      note =
        `Tunnel unavailable (${(err as Error).message}). ` +
        `Serving locally — retry later or use --local to skip this.`;
    }
  }

  /**
   * The same thing, asked for from the live panel rather than the command line.
   *
   * Returns the failure as a string instead of throwing, because the caller is
   * a keypress handler: there is nothing above it to catch, and the honest
   * outcome of "I pressed t and the machine has no route out" is a line on the
   * panel rather than a stack trace over the QR.
   *
   * Refuses when a tunnel is already up — `t` is not a re-arm. `n` is, and the
   * panel offers exactly one of the two at a time so the difference cannot be
   * discovered by accident.
   */
  let openingTunnel = false;
  const openTunnelFromPanel = async (): Promise<string | null> => {
    if (hosted || openingTunnel) return null;
    openingTunnel = true;
    try {
      hosted = await openTunnel();
      tunnelState = "up";
    } catch (err) {
      tunnelState = "retrying";
      return (err as Error).message;
    } finally {
      openingTunnel = false;
    }
    const invite = hosted?.invite;
    if (!invite) return "the tunnel opened without a code";
    dropLocalInvite();
    // The banner on screen says this machine is local-only, and it is now
    // wrong. `note` may also be carrying a failure from the start-up attempt,
    // which this supersedes.
    note = null;
    void serverState.write(record(invite.url)).catch(() => {});
    say("");
    say(
      kleur.green("  ✓ Tunnel open. This machine is reachable from anywhere."),
    );
    // The banner that follows carries "Sealed end to end — we pass it on, we
    // can't read it." beside the QR. Saying it here as well is the same
    // promise twice in four lines.
    reprint(invite);
    return null;
  };

  /**
   * The one line that keeps a local-by-default server from being a dead end.
   *
   * It used to say "run `mtmux start --hosted`", which is a strange thing to
   * tell somebody whose server is already running: stop it, retype it, and
   * arrive back where you were with one flag different. `t` does it here, in
   * place, without dropping whatever is already connected — so the flag is
   * demoted to the thing it is actually good for, which is not having to press
   * anything next time.
   *
   * Still only when this run was local *by default*. Someone who typed
   * `--local` has made this decision and does not need it explained, and a run
   * where the tunnel was asked for and failed has `note` saying what happened
   * — the key is still live in both cases, it is just not advertised.
   */
  const hint = offersTunnel
    ? // The keypress is offered beside the QR now, under the sentence that
      // creates the need for it. What is left here is the other half — not
      // having to press anything next time — which is a different thought and
      // belongs nowhere near the code somebody is in the middle of typing.
      kleur.dim("Always open a tunnel:  ") + "mtmux config set reach hosted"
    : null;

  localInvite = hosted ? null : armLocalInvite();

  if (opts.json) {
    say(
      JSON.stringify(
        {
          version,
          localUrl,
          lanUrl,
          mode: hosted ? "tunnel" : "local",
          // Both reaches report a code now. `mode` already says which kind it
          // is, and a consumer that only knew how to read a null here was
          // reading "local mode has no code", which stopped being true.
          code: liveInvite()?.code ?? null,
          joinUrl: liveInvite()?.url ?? null,
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
    waitingLineOnScreen = true;
    banner({
      version,
      localUrl,
      lanUrl,
      lanInterface,
      invite: liveInvite(),
      showQr: opts.qr,
      token: cfg.token,
      note,
      hint,
      canOpenTunnel: offersTunnel && hosted === null,
    });
  }

  if ((restored > 0 || needRepair > 0 || needRekey > 0) && !opts.json) {
    // Printed under the banner, so the "Waiting…" line is no longer the bottom
    // of the screen and must not be erased later.
    waitingLineOnScreen = false;
  }

  if (restored > 0 && !opts.json) {
    /*
     * Said out loud, including what it means for the approval prompt.
     *
     * This line used to stop at "already trusted", and that omission was
     * behind the most common complaint about this product's security model:
     * "it let a device in without asking me". It had asked — once, when that
     * device first paired, possibly weeks ago — and a device you approved is
     * a device you approved. But nothing on screen connected the two, so the
     * honest reading available to the user was that the prompt did not work.
     *
     * So the count now names the consequence and the way out, in the same
     * breath. A new device is still always asked about.
     */
    say(
      kleur.dim(
        `  ${restored} device${restored === 1 ? "" : "s"} already trusted — ` +
          `${restored === 1 ? "it comes" : "they come"} straight back in. Press `,
      ) +
        kleur.bold("a") +
        kleur.dim(" to be asked."),
    );
    say("");
  }

  if (needRekey > 0 && !opts.json) {
    // Deliberately not folded into `needRepair`: these devices are not broken,
    // they are reachable on this network and nowhere else. Saying "pair again"
    // to someone whose phone is working fine on the sofa reads as a lie.
    say(
      kleur.yellow(
        `  ${needRekey} device${needRekey === 1 ? "" : "s"} can reach this machine on this network only.`,
      ) + kleur.dim(" Pair again, once, to fix that."),
    );
    say("");
  }

  if (needRepair > 0 && !opts.json) {
    // Said plainly rather than left to fail as a mysterious auth error the
    // next time someone opens the tab on that device.
    say(
      kleur.yellow(
        `  ${needRepair} device${needRepair === 1 ? "" : "s"} need${needRepair === 1 ? "s" : ""} to pair again (one-time).`,
      ),
    );
    say("");
  }

  if (!opts.json) {
    const notice = describeUpdate(version, await updateCheck);
    if (notice.kind !== "current" || notice.advisory) {
      // Under the banner, so the "Waiting…" line is no longer the bottom of
      // the screen and must not be erased when a device pairs.
      waitingLineOnScreen = false;
      const colour = notice.kind === "outdated" ? kleur.yellow : kleur.dim;
      if (notice.kind !== "current") {
        say(colour(`  mtmux ${notice.detail}`));
        if (notice.fix) say(kleur.dim(`    ${notice.fix}`));
      }
      // The operator's own words, printed verbatim and last. This is the only
      // channel that reaches a running CLI without a release.
      if (notice.advisory) say(kleur.yellow(`  ${notice.advisory}`));
      say("");
    }
  }

  /**
   * The live panel, created after the banner so it sits below it.
   *
   * It takes over stdin, so the `prompt` seam in `decideAccess` is pointed at
   * it too — see `device-panel-control.ts` for why one owner of stdin is not
   * a nicety. When it declines to start (a pipe, `--json`, a short terminal,
   * a relay bundle that cannot list connections) everything below degrades to
   * exactly what this command did before: an append-only log and a readline
   * prompt.
   */
  /*
   * The paired list, cached and refreshed rather than read on every repaint.
   *
   * The panel redraws once a second while anything is connected, and the peer
   * list lives in a JSON file — so reading it at render time would be a disk
   * hit per frame and a panel that stutters whenever the disk is busy. It
   * changes only when this process changes it (a pairing, a rename, a revoke)
   * or when a `lastSeenAt` is touched, and all of those call `refreshPeers`.
   */
  let peerRows: PanelPeer[] = [];
  const refreshPeers = async (): Promise<void> => {
    const now = Date.now();
    peerRows = (await configStore.listPeers()).map((peer) => ({
      deviceId: peer.deviceId,
      label: peer.label,
      ...(peer.name ? { name: peer.name } : {}),
      pairedAt: peer.pairedAt,
      lastSeenAt: peer.lastSeenAt,
      expired: configStore.isPeerExpired(peer, now),
    }));
    panel?.refresh();
  };
  peerNameFor = (deviceId) =>
    peerRows.find((peer) => peer.deviceId === deviceId)?.name ?? null;
  await refreshPeers();

  panel = createDevicePanel({
    peers: () => peerRows,
    invite: liveInvite,
    askOnReconnect: () => askOnReconnect,
    setAskOnReconnect: async (value) => {
      askOnReconnect = value;
      // Persisted, because the panel is where the decision is made and a
      // choice that evaporates on restart is one you have to make again every
      // morning. `--trust-reconnect` still wins for the run it was passed to;
      // this writes the default that flag overrides.
      await configStore.setReconnectPolicy(value ? "confirm" : "trust");
    },
    rename: async (deviceId, name) => {
      const ok = await configStore.renamePeer(deviceId, name);
      await refreshPeers();
      return ok;
    },
    ...(relay.connectionDetails ? { details: relay.connectionDetails } : {}),
    ...(relay.onConnectionsChanged
      ? { subscribe: relay.onConnectionsChanged }
      : {}),
    ...(relay.disconnectConnection
      ? { disconnect: relay.disconnectConnection }
      : {}),
    /**
     * Clear the list: every pairing forgotten, every socket hung up.
     *
     * Three stores, like `revoke`, plus the sockets that have no pairing
     * record at all — the machine's own token, a share. Those are the ones a
     * per-row loop would miss, and they are exactly the rows somebody
     * reaching for "get rid of everything" means to include.
     */
    removeAll: async () => {
      const peers = await configStore.listPeers();
      for (const peer of peers) {
        if (peer.directToken) relay.revokeSessionToken?.(peer.directToken);
        hosted?.agent.removeSessionKeys(peer.deviceId);
        await configStore.removePeer(peer.deviceId);
      }
      // Anything still holding a socket — the machine's own token, a share —
      // is hung up. Revoking closed the paired ones already, so this is the
      // remainder rather than a second pass over the same list.
      for (const device of relay.connectionDetails?.() ?? []) {
        if (device.id) await relay.disconnectConnection?.(device.id);
      }
      await refreshPeers();
      return peers.length;
    },
    revoke: async (deviceId: string) => {
      // Both halves, and in this order. Dropping the peer record without
      // revoking the live token leaves the device connected until it happens
      // to reconnect; revoking without dropping the record means the next
      // start re-registers it and un-does the revoke.
      const peers = await configStore.listPeers();
      const peer = peers.find((p) => p.deviceId === deviceId);
      // A peer restored from a config written before per-device tokens has no
      // `directToken` to revoke. Dropping the record is still the right thing:
      // it is what stops the next start re-admitting it.
      if (!peer) return false;
      if (peer.directToken) relay.revokeSessionToken?.(peer.directToken);
      // And the third place a removed device still lives: the tunnel agent's
      // key ring. Revoking the token stops it authenticating; this stops it
      // opening a sealed stream to loopback at all, and closes the one it has.
      hosted?.agent.removeSessionKeys(deviceId);
      await configStore.removePeer(deviceId);
      await refreshPeers();
      return true;
    },
    rearm: () => {
      // Fire and forget: `onRearm` prints the new code when it lands, and the
      // panel has already said it is coming. Awaiting here would block the key
      // handler on a broker round trip.
      void hosted?.rearm().catch(() => {});
    },
    reprint: () => {
      const invite = hosted?.invite ?? null;
      if (invite) reprint(invite);
    },
    hosted: () => hosted !== null,
    tunnelStatus: () => tunnelPanelStatus(),
    openTunnel: openTunnelFromPanel,
    onQuit: () => shutdown(),
  });
  if (panel.enabled) {
    screen = panel;
    // From here the panel is the only reader on stdin. Anything still sitting
    // at a readline is taken down rather than left to fight it for keystrokes.
    stdinTakeover.abort();
    // The banner's trailing "Waiting…" is the panel's job now, and leaving the
    // claim on screen above a table that says the same thing better is two
    // writers disagreeing in the same column of pixels.
    waitingLineOnScreen = false;
  }

  watchConnectedDevices(relay, opts.json === true);

  // A device connecting or dropping is also the moment its peer record may
  // have changed — a fresh pairing writes one — and it is the cheapest honest
  // trigger for picking up a rename made by `mtmux devices rename` in another
  // shell. One small file read per connection event.
  relay.onConnectionsChanged?.(() => void refreshPeers());

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
    void configStore
      .touchPeer(deviceId, now)
      .then(refreshPeers)
      .catch(() => {
        // Bookkeeping on a file that may be read-only or full. Losing it costs
        // accuracy in `mtmux devices`, and must not cost the device its session.
      });
  });

  await serverState.write(record(liveInvite()?.url ?? null));

  /*
   * The local offer is single-use, so the moment it is spent the thing on
   * screen is wrong. Mint another and reprint.
   *
   * All three outcomes, not only success — that is the change. A code burned
   * by five wrong guesses used to leave the banner claiming a credential that
   * had stopped working, with nothing said, which is the one failure mode a
   * printed secret must never have. Now each outcome gets the sentence it
   * deserves and the same fresh code underneath it.
   */
  relay.onLocalPairingSpent((outcome) => {
    // With the tunnel up the banner is the hosted one, so re-arm quietly
    // rather than reprinting over it. The local code stays live either way —
    // a phone on this wifi should not lose the short route because a long one
    // opened.
    if (hosted) {
      localInvite = armLocalInvite();
      return;
    }
    clearWaitingLine();
    if (outcome === "paired") {
      say(kleur.green("  ✓ Device signed in."));
    } else if (outcome === "refused") {
      say(kleur.yellow("  ✗ Refused. Nothing was shared."));
    } else {
      // Worth a yellow line rather than a dim one. Five wrong guesses on a
      // local network is either a typo storm or somebody guessing, and the
      // owner is the only person who can tell which.
      say(kleur.yellow("  ✗ Too many wrong codes. That one is dead."));
    }
    localInvite = armLocalInvite();
    reprintCode(localInvite);
  });

  const { key } = await configStore.ensureDeviceKey();
  const stopHeartbeat = await registerWithAccount(
    base,
    opts.name ?? cfg.serverName ?? os.hostname(),
    Buffer.from(key.publicKey).toString("hex"),
  );
  if (opts.name) await configStore.setServerName(opts.name);

  if (opts.open) {
    // Opt-in since 0.7.1, and the flip is deliberate. `mtmux start` is most
    // often run over SSH, in a detached pane, or on a headless box, where
    // "helpfully" launching a browser is at best a stray window on whatever
    // machine happened to have a display and at worst a token-bearing URL
    // opened somewhere nobody was looking. The command already prints the URL
    // and a QR; `--open` is for the laptop case that actually wants it.
    //
    // The token still travels in the URL *fragment* (never the query): the
    // fragment is never sent to the server or logged, and the login page reads
    // it on mount to auto-authenticate — no manual copy-paste.
    const openUrl = `${localUrl}/login#token=${encodeURIComponent(cfg.token)}`;
    await openBrowser(openUrl).catch(() => {});
  }

  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    // First, and before anything is printed. `stop()` takes the terminal out
    // of raw mode and erases the panel, so "Stopping…" lands in a terminal
    // that echoes again rather than under a table that will never update.
    panel?.stop();
    panel = null;
    screen = {
      log: (...lines) => {
        if (lines.length === 0) console.log("");
        else for (const line of lines) console.log(line);
      },
    };
    say("\n  Stopping…");
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
