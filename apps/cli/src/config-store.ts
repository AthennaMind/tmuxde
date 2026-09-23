import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir, readFile, writeFile, chmod, rename } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import {
  generateDeviceKey,
  encodeDeviceKey,
  decodeDeviceKey,
  type DeviceKeyPair,
  type StoredDeviceKey,
  type StoredSessionKeys,
} from "@repo/crypto";

// Overridable so tests never touch the developer's real config, and so a user
// can keep their token somewhere other than $HOME.
const DIR = process.env.MTMUX_CONFIG_DIR ?? join(homedir(), ".mtmux");
const FILE = join(DIR, "config.json");

// This CLI shipped as `tmuxremote` before it was renamed to `mtmux`. Adopt the
// old token rather than silently issuing a new one — otherwise upgrading
// invalidates every bookmarked login URL the user has.
const LEGACY_FILE = join(homedir(), ".tmuxremote", "config.json");

/** A browser (or another CLI) this machine has paired with. */
export type PeerRecord = {
  deviceId: string;
  /** Ed25519 public key, hex. Used to verify reconnect challenges. */
  publicKey: string;
  /**
   * What the *browser* said it was, e.g. "iPhone · Safari".
   *
   * Self-reported and never trusted for anything. Two phones running the same
   * browser produce the same string, which is exactly the problem `name`
   * below exists to solve.
   */
  label: string;
  /**
   * What the *owner* calls it, when they have said.
   *
   * Set with `e` in the live panel or `mtmux devices rename`, and it wins over
   * `label` everywhere a device is shown. Held separately rather than
   * overwriting `label` so that a rename never destroys what the device
   * actually claimed to be — which is the one field that can contradict a
   * name, and therefore the one worth keeping when it does.
   *
   * "Work laptop" and "Kids iPad" is the difference between a list you can act
   * on and three rows that all say "Chrome on macOS".
   */
  name?: string;
  pairedAt: number;
  lastSeenAt: number;
  /**
   * The direct-path token derived with this peer, so restarting the server does
   * not force it to pair again.
   *
   * This is a deliberate weakening of an earlier property — relay session
   * tokens lived only in memory, so a restart revoked every device. That reads
   * well but is the wrong trade for a tool that runs on a server: it made every
   * deploy, crash or reboot cost a walk to another device. "Paired" should mean
   * what it means for a phone or a Bluetooth keyboard — trusted until revoked.
   *
   * The bound is still real: entries expire after `PEER_EXPIRY_MS`,
   * `mtmux devices revoke` deletes them, and the file is 0600 alongside the
   * machine's own auth token and Ed25519 secret, so this adds no secret to a
   * file that was not already the crown jewels.
   */
  directToken?: string;
  /**
   * The CPace-derived key schedule for this peer, so the tunnel survives a
   * restart too.
   *
   * `directToken` above fixed exactly half of this. It is the *relay's*
   * credential, so replaying it re-admits a device on the direct/LAN path — but
   * the tunnel agent binds a stream to a pairing by trial decryption against a
   * keyring held only in memory, so over the tunnel every previously-paired
   * device was refused with "no matching pairing" after any restart. A phone at
   * home kept working and the same phone on mobile data did not, which is a
   * strange enough shape that it read as a network fault rather than a bug.
   *
   * The honest cost, stated plainly: this file is 0600 and already holds
   * `AUTH_TOKEN`, the Ed25519 secret and a full-access `directToken`, so
   * nothing here widens what someone who can read it may *do* — they already
   * own the machine. What it does concede is confidentiality of *recorded past*
   * tunnel ciphertext, which was previously forward-secret across a restart by
   * accident rather than by design. Removing that concession means a signed
   * reconnect handshake against `publicKey` above, which is what that field was
   * always for; until then this is the trade.
   */
  sessionKeys?: StoredSessionKeys;
  /**
   * The grant this peer's `directToken` was issued under, when it was scoped.
   *
   * Absent means the full grant, which is what an ordinary `mtmux start`
   * pairing has always meant. It has to be persisted because
   * `restoreTrustedDevices` re-registers every peer at boot and the relay
   * defaults an omitted grant to full access — so a token issued for a
   * read-only, single-session `mtmux share` came back after a restart with the
   * run of the machine. The grant record itself is the authority on expiry and
   * revocation; this is only where it is kept.
   */
  grantId?: string;
};

/**
 * A signed-in account.
 *
 * Scoped to `apiBase` on purpose: a token minted by api.mtmux.com means nothing
 * to a self-hosted broker, and silently sending it there would be both useless
 * and a credential leak to a third party. Switching brokers therefore means
 * signing in again, which is the honest behaviour.
 */
export type Account = {
  token: string;
  userId: string;
  email: string;
  apiBase: string;
  /** The registry row this machine claimed, once it has registered. */
  serverId?: string;
};

export type Config = {
  token: string;
  /**
   * The pairing broker this machine uses, when it is not ours.
   *
   * Set with `mtmux config set api <url>`, and read by `resolveApiBase()`
   * ahead of the account's own broker. Separate from `Account.apiBase` on
   * purpose: pointing a machine at a self-hosted broker must not require
   * signing in to it first, since the broker a self-hoster runs may well have
   * no accounts at all (invariant #5).
   */
  apiBase?: string;
  /** This machine's device identity, created on first pair. */
  deviceKey?: StoredDeviceKey;
  peers?: PeerRecord[];
  account?: Account;
  /** What this machine calls itself in the dashboard. Defaults to hostname. */
  serverName?: string;
  /**
   * Whether a device that paired earlier may reconnect without being asked.
   *
   * `trust` — the default, and what every release so far has done. Paired means
   * paired: a phone reconnects the way a Bluetooth keyboard does, and a machine
   * running under systemd with nobody at it keeps working across a reboot.
   *
   * `confirm` — a returning device raises a prompt on this machine's terminal
   * the first time it reconnects after a restart. For someone who wants
   * "paired" to mean "paired, while I am watching".
   *
   * Defaulting to `confirm` was rejected: it would break every unattended
   * server on upgrade, and an unattended server is exactly the case
   * `mtmux approve` exists for.
   */
  reconnectPolicy?: ReconnectPolicy;
  /**
   * Whether this machine opens a tunnel by default. See `Reach`.
   *
   * Absent means `local`, which is also what a config written by an older
   * version means. Upgrading therefore *narrows* what a machine does on its
   * own, which is the safe direction for a default to move in.
   */
  reach?: Reach;
};

/**
 * How far `mtmux start` reaches when nobody says.
 *
 * `local` serves the LAN and loopback and contacts nothing. `hosted` also
 * opens a sealed tunnel and prints a code for app.mtmux.com, so a phone on
 * cellular in another country can pair.
 *
 * The default is `local`, and it used to be `hosted`. Reaching the internet is
 * the more useful behaviour and it is also the one with consequences, so it is
 * not a thing to do because somebody typed the shortest command in the product
 * without reading what it did. `--hosted` is one flag, and
 * `mtmux config set reach hosted` makes it the default for this machine.
 */
export type Reach = "local" | "hosted";

export const DEFAULT_REACH: Reach = "local";

export function isReach(value: unknown): value is Reach {
  return value === "local" || value === "hosted";
}

export async function getReach(): Promise<Reach> {
  const stored = (await load()).reach;
  return isReach(stored) ? stored : DEFAULT_REACH;
}

export async function setReach(reach: Reach): Promise<Config> {
  return write({ ...(await load()), reach });
}

export type ReconnectPolicy = "trust" | "confirm";

/**
 * What an unconfigured machine does when a device it already knows connects.
 *
 * `confirm`, on every run, with or without a terminal — and the conditional
 * default this replaces was a mistake worth naming, because it was invisible.
 *
 * The reasoning for it was that a machine started by systemd, by `nohup` or in
 * a detached pane has no terminal to ask at, so `confirm` there would refuse
 * every reconnect for want of anyone to answer. That is true of the *terminal*
 * and false of the machine: `decideAccess` races three channels, and two of
 * them — the app on a phone that is already connected, and `mtmux approve` in
 * any other shell — work perfectly well with no tty in sight. A headless box
 * can be asked. It just cannot be asked *on the screen it does not have*.
 *
 * What the conditional actually bought, then, was not availability. It was a
 * silent downgrade: the deployments least likely to be watched, most likely to
 * be reachable, and least able to notice were the ones that quietly stopped
 * asking. A security default that weakens itself exactly where the machine is
 * least supervised is the wrong way round.
 *
 * So there is one default and it is the safe one. A machine that genuinely
 * wants unattended reconnects says so, once, in a way its owner chose:
 * `mtmux config set reconnectPolicy trust`, or `--trust-reconnect`.
 */
export const DEFAULT_RECONNECT_POLICY: ReconnectPolicy = "confirm";

/**
 * Kept so the signature of `getReconnectPolicy` does not change under callers
 * and tests that pass the interactivity hint. Both defaults are now the same
 * value, deliberately — see above.
 */
export const INTERACTIVE_RECONNECT_POLICY: ReconnectPolicy = "confirm";

export function isReconnectPolicy(value: unknown): value is ReconnectPolicy {
  return value === "trust" || value === "confirm";
}

export async function getReconnectPolicy(
  interactive = false,
): Promise<ReconnectPolicy> {
  const stored = (await load()).reconnectPolicy;
  if (isReconnectPolicy(stored)) return stored;
  return interactive ? INTERACTIVE_RECONNECT_POLICY : DEFAULT_RECONNECT_POLICY;
}

export async function setReconnectPolicy(
  policy: ReconnectPolicy,
): Promise<Config> {
  return write({ ...(await load()), reconnectPolicy: policy });
}

/** The stored broker URL, or null when this machine uses the default. */
export async function getApiBase(): Promise<string | null> {
  return (await load()).apiBase ?? null;
}

/** Point this machine at a broker, or pass null to go back to the default. */
export async function setApiBase(url: string | null): Promise<Config> {
  const config = { ...(await load()) };
  if (url === null) delete config.apiBase;
  else config.apiBase = url.replace(/\/+$/, "");
  return write(config);
}

/**
 * Write the file atomically, 0600, into a 0700 directory.
 *
 * `writeFile` then `chmod` left a window — however short — in which the auth
 * token, the Ed25519 secret and every peer's direct token sat on disk at the
 * umask default, readable by anything else on the machine. Temp-then-rename
 * closes it, and is the pattern `grants-store.ts` already uses for the same
 * reason. The mode on the directory matters too: 0700 stops another user
 * enumerating the file names even where they cannot read the contents.
 */
async function write(cfg: Config): Promise<Config> {
  await mkdir(DIR, { recursive: true, mode: 0o700 });
  const tmp = `${FILE}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, FILE);
  return cfg;
}

export async function load(): Promise<Config> {
  try {
    return JSON.parse(await readFile(FILE, "utf8")) as Config;
  } catch {
    // Fall through to the legacy location, then to a fresh token.
  }
  try {
    const legacy = JSON.parse(await readFile(LEGACY_FILE, "utf8")) as Config;
    if (legacy?.token) return set(legacy.token);
  } catch {
    // No legacy config either.
  }
  return regenerate();
}

export async function regenerate(): Promise<Config> {
  // Deliberately preserves the device key and peers: rotating the auth token
  // should not un-pair every device the user owns.
  let existing: Partial<Config> = {};
  try {
    existing = JSON.parse(await readFile(FILE, "utf8")) as Config;
  } catch {
    // First run.
  }
  return write({
    ...existing,
    token: randomBytes(32).toString("hex"),
  });
}

export async function set(token: string): Promise<Config> {
  let existing: Partial<Config> = {};
  try {
    existing = JSON.parse(await readFile(FILE, "utf8")) as Config;
  } catch {
    // First run.
  }
  return write({ ...existing, token });
}

export async function save(cfg: Config): Promise<Config> {
  return write(cfg);
}

/**
 * This machine's long-lived identity, generated on first use.
 *
 * Once a browser has paired, reconnecting is a signed challenge against this
 * key rather than another six-digit code — so the code is needed exactly once,
 * ever.
 */
export async function ensureDeviceKey(): Promise<{
  config: Config;
  key: DeviceKeyPair;
}> {
  const config = await load();
  if (config.deviceKey) {
    try {
      return { config, key: decodeDeviceKey(config.deviceKey) };
    } catch {
      // A corrupted or hand-edited key is replaced rather than trusted; the
      // alternative is a device that cannot prove its identity and cannot be
      // revoked either.
    }
  }
  const key = generateDeviceKey();
  const updated = await write({ ...config, deviceKey: encodeDeviceKey(key) });
  return { config: updated, key };
}

/** The signed-in account, but only if it belongs to the broker being used. */
export async function getAccount(apiBase: string): Promise<Account | null> {
  const account = (await load()).account;
  if (!account) return null;
  return account.apiBase === apiBase ? account : null;
}

export async function setAccount(account: Account): Promise<Config> {
  return write({ ...(await load()), account });
}

export async function clearAccount(): Promise<Config> {
  const { account: _discarded, ...rest } = await load();
  return write(rest as Config);
}

export async function setServerName(name: string): Promise<Config> {
  return write({ ...(await load()), serverName: name });
}

export async function listPeers(): Promise<PeerRecord[]> {
  return (await load()).peers ?? [];
}

export async function addPeer(peer: PeerRecord): Promise<Config> {
  const config = await load();
  const peers = (config.peers ?? []).filter(
    (p) => p.deviceId !== peer.deviceId,
  );
  peers.push(peer);
  return write({ ...config, peers });
}

/** Returns false when no such peer was paired. */
export async function removePeer(deviceId: string): Promise<boolean> {
  const config = await load();
  const peers = config.peers ?? [];
  const remaining = peers.filter((p) => p.deviceId !== deviceId);
  if (remaining.length === peers.length) return false;
  await write({ ...config, peers: remaining });
  return true;
}

/**
 * Give a paired device a name of your own, or clear it back to the browser's.
 *
 * Returns false when there is no such peer, so a caller can tell "renamed" from
 * "that device is already gone" instead of reporting a success it did not have.
 */
export async function renamePeer(
  deviceId: string,
  name: string | null,
): Promise<boolean> {
  const config = await load();
  const peers = config.peers ?? [];
  const peer = peers.find((p) => p.deviceId === deviceId);
  if (!peer) return false;
  const trimmed = (name ?? "").trim().slice(0, MAX_PEER_NAME);
  if (trimmed) peer.name = trimmed;
  else delete peer.name;
  await write({ ...config, peers });
  return true;
}

/**
 * Longest name a device may carry.
 *
 * Not a storage concern — it is a layout one. The name is drawn in a table
 * that has to survive a 40-column terminal, and a label long enough to eat
 * every other column turns the list into one field.
 */
export const MAX_PEER_NAME = 32;

/**
 * What to call a device on screen: the owner's name, else the browser's label.
 *
 * One function, so the panel, `mtmux devices` and the details card cannot
 * disagree about which of the two fields wins.
 */
export function displayName(peer: { name?: string; label?: string }): string {
  return (peer.name ?? "").trim() || (peer.label ?? "").trim() || "";
}

export async function touchPeer(
  deviceId: string,
  at = Date.now(),
): Promise<void> {
  const config = await load();
  const peers = config.peers ?? [];
  const peer = peers.find((p) => p.deviceId === deviceId);
  if (!peer) return;
  peer.lastSeenAt = at;
  await write({ ...config, peers });
}

/** Device keys idle for this long are treated as stale by `mtmux devices`. */
export const PEER_EXPIRY_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * Defined in terms of the remaining lifetime rather than alongside it.
 *
 * Two expressions of one rule drift, and these two drifted at exactly the
 * boundary: `>` here said a peer with zero remaining life was still valid, so
 * `restoreTrustedDevices` handed the relay `ttlMs: 0` for it — which the relay
 * read as "unspecified" and turned back into the 24 h default. One instant of
 * the day, the bug this whole change exists to remove came back.
 */
export function isPeerExpired(peer: PeerRecord, now = Date.now()): boolean {
  return peerLifetimeRemainingMs(peer, now) <= 0;
}

/**
 * How much of a peer's trust is left, in ms — never below zero.
 *
 * Handed to the relay as the session token's idle window when a trusted device
 * is restored at boot, so the relay can never keep honouring a credential this
 * store would already refuse. Derived from the same two values `isPeerExpired`
 * compares, deliberately: two expressions of one rule drift, and the direction
 * they drift in here is "the relay still lets in a device `mtmux devices` has
 * forgotten".
 */
export function peerLifetimeRemainingMs(
  peer: PeerRecord,
  now = Date.now(),
): number {
  return Math.max(0, PEER_EXPIRY_MS - (now - peer.lastSeenAt));
}
