import http from "node:http";
import type { Duplex } from "node:stream";
import kleur from "kleur";

export const RELAY_PATH = "/_relay";

/**
 * How long shutdown may take before the process is killed outright.
 *
 * Generous enough for close frames and the server's own callback on a healthy
 * box; short enough that Ctrl+C always feels like Ctrl+C. Nothing here is worth
 * waiting on — there is no write to flush, and every client reconnects.
 */
const FORCE_EXIT_MS = 2_000;

/**
 * The subset of `apps/relay/src/runtime.ts` this module needs. Passed in rather
 * than imported so the same assembly works against the esbuild bundle (`start`)
 * and the raw TypeScript source (`scripts/dev.mjs`, via tsx).
 */
/**
 * One connected socket, in the detail the in-process live panel needs.
 *
 * Declared here rather than imported from `@app/relay`, and that is not an
 * oversight: this CLI *bundles* the relay, so the two have no type-level link
 * at build time. Every field past the first three is optional because the
 * bundle may be older than this file. Keep in step with `ConnectionDetail` in
 * `connection-manager.ts` — and note that the narrower `ConnectedDevice` there
 * is the one that may cross the loopback control endpoint. This one may not.
 */
export type ConnectedDevice = {
  label: string;
  connectedAt: number;
  readOnly: boolean;
  /** Absent from a bundle that predates the live panel. */
  id?: string;
  lastActivityAt?: number;
  attachedSession?: string | null;
  tokenId?: string | null;
  deviceId?: string | null;
  remoteAddress?: string | null;
  scope?:
    | { kind: "all" }
    | { kind: "sessions"; sessions: string[] }
    | { kind: "recordings"; count: number };
  /** What the grant allows on disk. Independent of `readOnly`. */
  files?: "none" | "read" | "write";
  /** When the credential stops working, for a share that has an end. */
  expiresAt?: number | null;
  /** The viewer's terminal size, as last applied to the PTY. */
  size?: { cols: number; rows: number } | null;
  /** How the socket arrived. Absent on a bundle that predates the field. */
  transport?: "loopback" | "lan" | "tunnel";
  /** The browser's raw `user-agent`, when it sent one. */
  userAgent?: string | null;
};

export type RelayRuntime = {
  createWsServerNoBind: () => import("ws").WebSocketServer;
  attachUpgrade: (
    server: http.Server,
    wss: import("ws").WebSocketServer,
    path: string,
    fallback?: (
      req: http.IncomingMessage,
      socket: Duplex,
      head: Buffer,
    ) => void,
  ) => void;
  wireConnections: (wss: import("ws").WebSocketServer) => {
    shutdown: () => void;
  };
  handleRelayRequest: (
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ) => Promise<boolean>;
  /** Arms tokenless local pairing and returns the nonce for the QR. */
  issuePairingNonce: (ttlMs?: number) => { nonce: string; expiresAt: number };
  /** Fires when a device redeems the nonce, so the CLI can reprint a code. */
  onPairingRedeemed: (listener: () => void) => () => void;
  /**
   * Who is connected right now.
   *
   * Optional because `scripts/dev.mjs` and any older bundle this file is
   * pointed at may predate it, and a missing device count must degrade to no
   * device line rather than to a crash on boot.
   */
  connectionSummary?: () => {
    count: number;
    devices: ConnectedDevice[];
  };
  /**
   * The same connections in full, for the in-process live panel only.
   *
   * Separate from `connectionSummary` because that one is served over the
   * loopback control endpoint to other processes, and an address or a session
   * name does not belong there. See `connection-manager.ts`.
   */
  connectionDetails?: () => ConnectedDevice[];
  /**
   * Hang up on one socket. Resolves false when there was nothing to hang up on.
   *
   * Optional like everything else here: against a relay bundle that predates
   * it the live panel simply does not offer the action, rather than offering
   * one that silently does nothing.
   */
  disconnectConnection?: (id: string) => Promise<boolean>;
  /** Fires when a device authenticates or drops. */
  onConnectionsChanged?: (listener: () => void) => () => void;
  /**
   * Fires when a registered device successfully uses its session token.
   *
   * The relay is the only part of the process that sees a device authenticate,
   * so without this the CLI's peer store cannot tell a phone in daily use from
   * one abandoned at pairing — and `mtmux devices` expires the former on
   * schedule. Optional for the same reason the two hooks above are: an older
   * bundle this file is pointed at simply does not report it.
   */
  onSessionTokenUsed?: (listener: (deviceId: string) => void) => () => void;
  /**
   * Register a session token without going through the loopback HTTP endpoint.
   *
   * `registerDirectToken` POSTs to `/_pair/session`, which means the server has
   * to be listening before trusted devices can be restored — and a phone that
   * reconnected in that window was refused, which the browser treats as
   * terminal and answers by wiping its credential and bouncing to `/start`.
   * Registering in-process closes the window: nothing is accepting connections
   * yet when it runs.
   *
   * Optional so an older bundle degrades to the HTTP path rather than crashing.
   */
  registerSessionToken?: (
    token: string,
    ttlMs?: number,
    now?: number,
    grant?: import("@repo/protocol").GrantRecord,
    label?: string,
    deviceId?: string,
  ) => unknown;
  /**
   * Drop a session token from the live relay, for `mtmux devices revoke`.
   *
   * Optional for the same reason as the rest: an older bundle degrades to the
   * old behaviour, where a revoked device kept its socket until a restart.
   */
  revokeSessionToken?: (token: string) => void;
  /**
   * Ask every connected browser whether to admit a new device.
   *
   * Resolves `true`/`false` for an answer, and `null` to abstain — nobody is
   * connected who may answer, or the last one closed the tab. Abstaining hands
   * the decision back to the TTY prompt and `mtmux approve`; it never makes it.
   *
   * Optional like the rest of this block: an older bundle simply has no in-app
   * channel, and `decideAccess` degrades to the machine's own prompts.
   */
  askDeviceApproval?: (
    req: {
      sas?: string;
      deviceLabel: string;
      accountEmail: string;
      via?: "code" | "request";
    },
    opts?: { timeoutMs?: number; signal?: AbortSignal },
  ) => Promise<boolean | null>;
  /**
   * The recorder, for the `/_control/record` endpoint.
   *
   * Optional like everything above it: a bundle that predates recording must
   * make `mtmux record` say so plainly rather than crash the server it is
   * embedded in.
   */
  recorder?: {
    list(): import("@repo/protocol").RecordingInfo[];
    start(options: {
      target: import("@repo/protocol").RecordingTarget;
      title?: string;
    }): Promise<import("@repo/protocol").RecordingInfo>;
    stop(
      id: string,
      reason?: import("@repo/protocol").RecordingStopReason,
    ): Promise<import("@repo/protocol").RecordingInfo | null>;
    stopAll(
      reason?: import("@repo/protocol").RecordingStopReason,
    ): Promise<void>;
  };
  /** The recordings index, for listing and deleting. */
  recordings?: {
    list(): Promise<import("@repo/protocol").RecordingInfo[]>;
    remove(id: string): Promise<boolean>;
  };
};

export type ServeOptions = {
  relay: RelayRuntime;
  /** Next's request handler, from an already-prepared app. */
  requestHandler: (
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ) => Promise<void> | void;
  /**
   * Next's upgrade handler. Required in dev — HMR runs over a WebSocket — and
   * deliberately omitted in production, where the relay is the only upgrade.
   */
  upgradeHandler?: (
    req: http.IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ) => void;
  port: number;
  host: string;
  /** Command to suggest in the "port in use" hint, e.g. "mtmux start". */
  portHintCommand: string;
  /**
   * CLI-owned HTTP endpoints, tried before the relay's.
   *
   * This exists for `mtmux approve`, which is a second process and therefore
   * cannot reach the daemon's memory any other way — the same problem
   * `registerDirectToken` solves by POSTing to `/_pair/session`. Putting the
   * hook here rather than in the relay keeps a CLI-only feature out of the
   * relay package, which is also shipped standalone.
   *
   * Returns true when it handled the request.
   */
  controlHandler?: (
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ) => Promise<boolean>;
};

export type Serving = {
  server: http.Server;
  shutdown: () => void;
};

/**
 * Bind web + relay to a single port.
 *
 * This is the whole point of the CLI, and dev goes through it too, so a bug in
 * the single-port wiring can't hide until release.
 */
export async function serve(opts: ServeOptions): Promise<Serving> {
  const { relay } = opts;

  const server = http.createServer(async (req, res) => {
    // CLI control endpoints first — they are loopback-and-token guarded and
    // must not be shadowed by anything the relay or Next might claim.
    if (opts.controlHandler && (await opts.controlHandler(req, res))) return;
    // Relay HTTP endpoints take priority (/health, /file?...)
    const handled = await relay.handleRelayRequest(req, res);
    if (handled) return;
    await opts.requestHandler(req, res);
  });

  const wss = relay.createWsServerNoBind();
  const { shutdown: shutdownConnections } = relay.wireConnections(wss);
  relay.attachUpgrade(server, wss, RELAY_PATH, opts.upgradeHandler);

  // Next.js's NextServer lazily registers its own `upgrade` listener on the
  // first request (it routes to its internal upgradeHandler, used for HMR in
  // dev). In our embedded setup that listener fires alongside ours on every
  // /_relay upgrade and destroys the socket because the path is unknown to
  // Next — clients see a successful WS open immediately followed by close
  // code 1006. Block any subsequent `upgrade` listener registration so only
  // attachUpgrade above ever runs; in dev we invoke Next's handler ourselves
  // via `upgradeHandler`, so HMR still works.
  const origOn = server.on.bind(server);
  const origAddListener = server.addListener.bind(server);
  const origPrepend = server.prependListener.bind(server);
  function guard<T extends (...a: never[]) => unknown>(method: T): T {
    return ((event: string, listener: (...args: unknown[]) => void) => {
      if (event === "upgrade") return server;
      return (method as unknown as (e: string, l: unknown) => unknown)(
        event,
        listener,
      );
    }) as unknown as T;
  }
  server.on = guard(origOn);
  server.addListener = guard(origAddListener);
  server.prependListener = guard(origPrepend);

  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (err: NodeJS.ErrnoException) => {
        server.off("listening", onListening);
        reject(err);
      };
      const onListening = () => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(opts.port, opts.host);
    });
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "EADDRINUSE") {
      console.error(
        kleur.red(`✗ Port ${opts.port} is already in use on ${opts.host}.`),
      );
      console.error(
        kleur.dim(
          `  Try another port: ${kleur.bold(`${opts.portHintCommand} --port ${opts.port + 1}`)}`,
        ),
      );
      console.error(
        kleur.dim(
          `  Or stop whatever is on it: ${kleur.bold(`lsof -i :${opts.port}`)} (macOS/Linux)`,
        ),
      );
    } else if (e.code === "EACCES") {
      console.error(
        kleur.red(`✗ Permission denied binding to ${opts.host}:${opts.port}.`),
      );
      console.error(
        kleur.dim(
          "  Ports < 1024 require elevated privileges. Pick a higher port.",
        ),
      );
    } else {
      console.error(kleur.red(`✗ ${e.message}`));
    }
    wss.close();
    process.exit(1);
  }

  return {
    server,
    /**
     * Stop, and be certain about it.
     *
     * `process.exit` used to live *only* inside `server.close`'s callback, and
     * that callback fires only once every connection has gone. `wss.close()`
     * does not hang up existing clients and `server.close()` does not touch
     * keep-alives, so a single open browser tab meant Ctrl+C printed
     * "Stopping…" and then hung forever — nothing on screen, nothing to do but
     * Ctrl+C again harder.
     *
     * Three layers now, cheapest first: close the sockets we know about, tell
     * Node to drop the rest, and hard-exit on a deadline if anything is still
     * holding on. The deadline is the one that makes this a guarantee rather
     * than an improvement — nothing a client does can keep the CLI alive.
     */
    shutdown: () => {
      shutdownConnections();
      wss.close();

      server.close(() => process.exit(0));
      // Keep-alive sockets are not connections `server.close()` will wait out;
      // they are connections it waits *for*. Node 18.2+ can drop them.
      server.closeAllConnections?.();

      const forced = setTimeout(() => process.exit(0), FORCE_EXIT_MS);
      // Unref'd so it never delays an exit that happened on its own.
      forced.unref?.();
    },
  };
}
