import kleur from "kleur";
import { sanitizeLabel } from "@repo/protocol";

import { displayWidth, fit, pad, rule, since } from "./live-view.js";
import type { ConnectedDevice } from "./serve.js";

/**
 * What `mtmux start` shows once the banner is done: who is on this machine,
 * and what you can do about it.
 *
 * ## What it replaced, and why that was not enough
 *
 * The command used to append one line per event — "✓ iPhone connected", "·
 * iPhone disconnected" — and nothing else. That answers "did something just
 * happen", which is the smaller half of the question. The half it could not
 * answer is the one people actually leave the terminal open for: *who is on
 * my machine right now, and how do I get rid of them.* You could read the
 * whole scrollback and still not know, because the answer is a running total
 * of every line since boot and two of those lines may name the same phone.
 *
 * So the state is drawn as state. The event log stays — it is genuinely
 * useful, and it is what a service unit still gets — but the bottom of the
 * screen now holds the current answer rather than a diff from ten minutes ago.
 *
 * ## Connected is not the same as paired, and both belong here
 *
 * The first version of this listed live sockets only, which quietly made the
 * panel useless for the most common thing anyone wants to do to a device:
 * get rid of one that is not currently here. A phone you lent to somebody, a
 * laptop you have sold, a tablet in a drawer — none of them hold a socket, all
 * of them hold a credential, and the only way to act on one was to quit the
 * server and run `mtmux devices revoke <id>` with an id you had to go and
 * find.
 *
 * So the list is every device this machine trusts, with the connected ones
 * first. An offline row is dim and carries "last seen" instead of an idle
 * time, and every action that makes sense for it — rename, revoke — works from
 * the same keys.
 *
 * ## The verbs, kept apart on purpose
 *
 * `c` closes a socket. The credential stays valid and the browser may come
 * back; it is "hang up", for the tab you left open somewhere else.
 * `r` revokes the device. That is permanent and it un-pairs.
 * `e` renames it, which changes nothing about what it may do — it is there
 * because three rows reading "Chrome on macOS" is a list you cannot act on.
 *
 * `c` and `r` are offered together, precisely so that nobody reaches for the
 * permanent one to solve a temporary problem. Revoke asks for confirmation
 * and close does not, because the cost of a wrong close is one reconnect and
 * the cost of a wrong revoke is pairing again from scratch.
 *
 * ## Rendering rules
 *
 * Pure. `render()` takes a width and some state and returns lines; it never
 * writes, never measures the terminal and never reads the clock except through
 * the `now` it is handed. That is what lets the whole panel be asserted as
 * strings in a test, which is the only practical way to check a layout that
 * has to survive a 40-column terminal and a label full of emoji.
 */

/** A device this machine trusts, whether or not it is here right now. */
export type PanelPeer = {
  deviceId: string;
  /** What the browser called itself. */
  label: string;
  /** What the owner called it, if they have. */
  name?: string;
  pairedAt: number;
  lastSeenAt: number;
  /** Idle past `PEER_EXPIRY_MS` — it will not be restored on the next boot. */
  expired: boolean;
};

/**
 * One line in the list: a live connection, a trusted device, or both.
 *
 * Both is the common case and the reason this is one type rather than two
 * lists rendered separately — a connected phone that is also paired is one
 * thing to the person reading, and splitting it in two would make `r` act on a
 * row that looks like a different device from the one `c` acts on.
 */
export type PanelRow = {
  /**
   * Stable identity for the cursor.
   *
   * The device id when there is one, otherwise the socket id. Cursors used to
   * be plain indices, which meant a device dropping off the top of the list
   * silently moved the selection onto whichever row slid into that slot — so
   * the confirmation you were reading was about a different device by the time
   * you pressed `y`.
   */
  key: string;
  /** What to call it: the owner's name if set, else the browser's label. */
  name: string;
  deviceId: string | null;
  /** The socket, when it is connected right now. */
  live: ConnectedDevice | null;
  /** The stored record, when this machine trusts it. */
  peer: PanelPeer | null;
};

export type PanelMode =
  | { kind: "list" }
  | { kind: "help" }
  /**
   * Everything known about one row.
   *
   * Held by key rather than by cursor index, so a device that drops while its
   * card is open shows "it has gone" instead of silently becoming whichever
   * device slid into that row.
   */
  | { kind: "details"; key: string | null }
  /** A destructive action waiting on y/n, holding what it will act on. */
  | { kind: "confirm"; action: "revoke"; deviceId: string; label: string }
  /** Typing a new name. `draft` is what has been typed so far. */
  | { kind: "rename"; deviceId: string; label: string; draft: string }
  /** A device is asking to be let in. Nothing else is reachable until answered. */
  | {
      kind: "approval";
      label: string;
      account: string;
      sas?: string;
      expiresAt: number;
    };

export type PanelState = {
  rows: PanelRow[];
  /** Index into `rows`. Clamped at render, never trusted. */
  cursor: number;
  mode: PanelMode;
  /** Shown under the table for a few seconds after an action. */
  flash: string | null;
  now: number;
  /** Whether a tunnel is up, which decides if `n` can mean anything. */
  hosted: boolean;
  /**
   * Whether `t` can mean anything: no tunnel yet, and something able to open
   * one. False on a relay bundle with no `openTunnel` wired, where offering
   * the key would be offering a key that does nothing.
   */
  canOpenTunnel: boolean;
  /**
   * Whether a device that has paired before is asked about when it comes back.
   *
   * On screen because it is the answer to the most common complaint about this
   * product's approval model — "it did not ask me" — which is almost always a
   * device that was approved once, weeks ago, doing exactly what it was told
   * it could. A setting nobody can see is a setting nobody can be wrong about.
   */
  askOnReconnect: boolean;
  /** Set while the panel cannot act — during shutdown. */
  frozen: boolean;
};

/** Longest a flash line stays before the panel forgets it. */
export const FLASH_MS = 4000;

/** Rows the table gives to devices before it starts saying "+N more". */
const MAX_ROWS = 8;

/** Longest name the rename editor will take. Matches `MAX_PEER_NAME`. */
export const MAX_NAME_INPUT = 32;

export function render(state: PanelState, columns: number): string[] {
  const width = Math.max(40, columns);
  switch (state.mode.kind) {
    case "approval":
      return approval(state, state.mode, width);
    case "help":
      return help(state, width);
    case "details":
      return detailCard(state, state.mode, width);
    case "confirm":
      return confirm(state.mode, width);
    case "rename":
      return rename(state.mode, width);
    default:
      return list(state, width);
  }
}

/**
 * Build the list: connected first, then everything else this machine trusts.
 *
 * Exported and pure so the ordering — which is the whole readability of the
 * panel — can be asserted directly rather than inferred from rendered strings.
 */
export function buildRows(
  devices: ConnectedDevice[],
  peers: PanelPeer[],
): PanelRow[] {
  const byId = new Map(peers.map((peer) => [peer.deviceId, peer]));
  const seen = new Set<string>();
  const rows: PanelRow[] = [];

  for (const live of devices) {
    const peer = live.deviceId ? (byId.get(live.deviceId) ?? null) : null;
    if (peer) seen.add(peer.deviceId);
    rows.push({
      key: live.deviceId ?? live.id ?? `socket-${rows.length}`,
      // The stored name wins over the browser's label even for a live socket:
      // the relay's label came from the token, which was issued before anybody
      // had renamed anything.
      name: peer ? displayName(peer) : sanitizeLabel(live.label),
      deviceId: live.deviceId ?? null,
      live,
      peer,
    });
  }

  // Oldest contact last, so the thing most likely to be wanted is nearest the
  // connected rows rather than buried under a year of forgotten tablets.
  const offline = peers
    .filter((peer) => !seen.has(peer.deviceId))
    .sort((a, b) => b.lastSeenAt - a.lastSeenAt);

  for (const peer of offline) {
    rows.push({
      key: peer.deviceId,
      name: displayName(peer),
      deviceId: peer.deviceId,
      live: null,
      peer,
    });
  }

  return rows;
}

/**
 * The owner's name if there is one, else what the browser said.
 *
 * Sanitised, and that is not belt-and-braces. `label` is whatever a peer
 * claimed to be, and it is drawn into a table on somebody's terminal — 120
 * bytes is ample room for ANSI that walks the cursor up the screen and
 * redraws the approval prompt above it. `sanitizeLabel`'s own header makes
 * that argument at length; this is the render site it names.
 *
 * The owner's own `name` goes through it too. It cannot be hostile by
 * construction, but the rule "nothing reaches the terminal unstripped" is
 * worth more than the one exception is worth saving.
 */
export function displayName(peer: { name?: string; label: string }): string {
  return sanitizeLabel(peer.name ?? "") || sanitizeLabel(peer.label);
}

function list(state: PanelState, width: number): string[] {
  const lines = [rule(width)];
  const connected = state.rows.filter((row) => row.live !== null).length;
  const offline = state.rows.length - connected;

  lines.push(
    ` ${kleur.bold(headline(connected))}` +
      (offline > 0 ? kleur.dim(`   ·   ${offline} paired, not here`) : "") +
      (state.hosted ? kleur.dim("   ·   tunnel up") : ""),
  );

  if (state.rows.length === 0) {
    // Not an empty table. A header row over nothing reads as a bug, and the
    // useful thing to say here is what to do next rather than what is absent.
    lines.push(
      kleur.dim(
        state.hosted
          ? "  Scan the code above, or press n for a fresh one."
          : "  Scan the code above, or type the six digits at the address.",
      ),
    );
  } else {
    const shown = state.rows.slice(0, MAX_ROWS);
    const cursor = clamp(state.cursor, shown.length);
    let drewDivider = false;
    shown.forEach((row, i) => {
      // One dim heading, exactly where the meaning of the rows changes. Two
      // tables with two headers would cost four lines to say what one says.
      if (!drewDivider && row.live === null && connected > 0) {
        lines.push(kleur.dim("   ── paired, not connected ──"));
        drewDivider = true;
      }
      lines.push(rowLine(row, i === cursor, state.now, width));
    });
    if (state.rows.length > shown.length) {
      lines.push(kleur.dim(`  … and ${state.rows.length - shown.length} more`));
    }
  }

  if (state.flash) lines.push(` ${state.flash}`);
  /*
   * The one line that keeps a local-only server from being a dead end.
   *
   * `t` is already in the key bar, where it is two characters next to six
   * other pairs of characters — which is to say, invisible to anyone who has
   * not already been told what it does. The thing being offered is the
   * product's headline feature, reachable in one keypress, and it was going
   * unnoticed because it was spelled as a key rather than as an offer.
   *
   * Suppressed while a flash is up: `doOpenTunnel` puts "Opening an encrypted
   * tunnel…" there, and inviting someone to press the key they just pressed is
   * worse than saying nothing.
   */
  if (state.canOpenTunnel && !state.flash) lines.push(tunnelOffer(width));
  lines.push(keyBar(state, width));
  return lines;
}

/**
 * The offer, in whichever wording fits.
 *
 * Assembled from parts and measured as plain text rather than run through
 * `fit`, because `fit` counts columns and a bolded `t` is nine characters of
 * escape sequence for one column of ink. Truncating a sentence whose last
 * three words are "sealed end to end" would also cut exactly the part worth
 * reading, so the narrow terminal gets a different sentence rather than half
 * of this one.
 */
function tunnelOffer(width: number): string {
  const variants: [string, string][] = [
    [
      "This network only. Press ",
      " to reach it from anywhere, sealed end to end.",
    ],
    ["Press ", " for an encrypted tunnel."],
  ];
  const [before, after] =
    variants.find(([a, b]) => 2 + a.length + 1 + b.length <= width) ??
    variants[1]!;
  return ` ${kleur.dim(before)}${kleur.bold("t")}${kleur.dim(after)}`;
}

function headline(count: number): string {
  if (count === 0) return "Nothing connected";
  return `${count} device${count === 1 ? "" : "s"} connected`;
}

/**
 * One device.
 *
 * The widths are computed from the terminal rather than fixed, because the
 * name is the only field whose length is not ours — it is whatever the browser
 * produced, or whatever the owner typed — and a fixed layout either truncates
 * it to uselessness at 120 columns or overflows at 60.
 *
 * Everything is measured in one place and the line is assembled from exactly
 * those pieces. The first version of this computed a `fixed` cost separately
 * from the string it then built, the two disagreed by one column, and the row
 * overflowed at 40 — the bug that only appears at a width nobody opens a
 * terminal at, until somebody does.
 *
 * Below 64 columns the session column is dropped rather than squeezed. Losing
 * a whole field is honest; three fields all cut to an ellipsis is a table that
 * has stopped being one.
 */
function rowLine(
  row: PanelRow,
  isSelected: boolean,
  now: number,
  width: number,
): string {
  const AGE_W = 4;
  const IDLE_W = 9;
  const WHERE_W = 14;

  const device = row.live;
  const age = pad(device ? since(device.connectedAt, now) : "", AGE_W);
  const idle = pad(statusText(row, now), IDLE_W);
  const tag = badge(row);
  const showWhere = width >= 64;
  const where = showWhere ? pad(whereText(row), WHERE_W) : null;

  // " " + marker + " " … then one space before each remaining field.
  const spent =
    3 +
    (where ? WHERE_W + 1 : 0) +
    AGE_W +
    1 +
    IDLE_W +
    1 +
    displayWidth(stripAnsi(tag));
  const name = pad(row.name, Math.max(6, width - spent));

  const marker = isSelected ? kleur.cyan("▸") : " ";
  // An offline row is dim in full, including its name: the list has to be
  // readable as "who is here" at a glance, and colour is the only channel
  // that survives being glanced at.
  const shown = isSelected ? kleur.bold(name) : device ? name : kleur.dim(name);
  const middle = where ? ` ${kleur.dim(where)}` : "";
  return ` ${marker} ${shown}${middle} ${kleur.dim(age)} ${kleur.dim(idle)}${tag}`;
}

/**
 * Measure a coloured string as the terminal will.
 *
 * `badge()` returns text wrapped in escapes, and counting those as columns
 * would steal ten of them from the name on every read-only row.
 */
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function statusText(row: PanelRow, now: number): string {
  if (!row.live) {
    if (!row.peer) return "";
    return row.peer.expired ? "stale" : since(row.peer.lastSeenAt, now);
  }
  if (row.live.lastActivityAt === undefined) return "";
  const quiet = now - row.live.lastActivityAt;
  // Under ten seconds is "now" rather than a number that changes every render
  // and draws the eye to a connection doing nothing interesting.
  return quiet < 10_000
    ? "live"
    : `idle ${since(row.live.lastActivityAt, now)}`;
}

function whereText(row: PanelRow): string {
  const device = row.live;
  if (!device) return "—";
  if (device.attachedSession) return device.attachedSession;
  if (device.scope?.kind === "sessions") {
    return device.scope.sessions.join(",") || "—";
  }
  if (device.scope?.kind === "recordings") return "recordings";
  return "—";
}

/** The one thing worth colouring: a connection that is not a full session. */
function badge(row: PanelRow): string {
  const device = row.live;
  if (!device) return "";
  if (device.readOnly) return kleur.yellow(" read-only");
  if (device.scope && device.scope.kind !== "all") return kleur.cyan(" shared");
  return "";
}

function keyBar(state: PanelState, width: number): string {
  const row = selected(state);
  const keys: string[] = [];
  if (state.rows.length > 1) keys.push(key("↑↓", "select"));
  if (row) {
    keys.push(key("d", "details"));
    if (row.live) keys.push(key("c", "close"));
    // Only when there is a device behind the row. The machine's own token has
    // none, and offering to revoke it would offer to revoke the credential
    // this terminal is printing.
    if (row.deviceId) {
      keys.push(key("e", "rename"));
      keys.push(key("r", "revoke"));
    }
  }
  // Exactly one of these is ever offered, and the pair is why: `n` replaces a
  // code that exists, `t` creates the thing that has codes at all. Showing
  // both would invite someone with no tunnel to press the one that cannot work.
  if (state.hosted) keys.push(key("n", "new code"));
  else if (state.canOpenTunnel) keys.push(key("t", "tunnel"));
  keys.push(key("?", "help"), key("q", "quit"));
  return ` ${fit(keys.join(kleur.dim("   ")), width - 2)}`;
}

/**
 * One device, in full.
 *
 * The table row answers "who is here"; this answers "what exactly is it, and
 * what is it allowed to do". That second question had no answer anywhere short
 * of reading the config file by hand — `mtmux devices` lists paired devices
 * rather than live sockets, and the row has room for a name, an age and a
 * badge.
 *
 * Fields are omitted when they have nothing to say, rather than printed as a
 * dash. A card of eleven rows where four read "—" trains the eye to skip it.
 */
function detailCard(
  state: PanelState,
  mode: Extract<PanelMode, { kind: "details" }>,
  width: number,
): string[] {
  const row =
    state.rows.find((r) => r.key === mode.key) ??
    (mode.key === null ? selected(state) : null);

  if (!row) {
    return [
      rule(width),
      ` ${kleur.bold("That device has gone")}`,
      ` ${kleur.dim(fit("It dropped while this was open. Any key to go back.", width - 2))}`,
    ];
  }

  const lines = [rule(width), ` ${kleur.bold(fit(row.name, width - 2))}`];
  const field = (label: string, value: string) => {
    lines.push(` ${kleur.dim(pad(label, 10))} ${fit(value, width - 13)}`);
  };

  // What the browser claims, when it is not what the row already says. Shown
  // only when a rename has made the two differ, because that is the only time
  // it carries information.
  if (row.peer?.name && row.peer.label && row.peer.label !== row.name) {
    field("Browser", sanitizeLabel(row.peer.label));
  }

  const device = row.live;
  if (device) {
    field(
      "Connected",
      `${since(device.connectedAt, state.now)} ago` +
        (device.lastActivityAt === undefined
          ? ""
          : `   ·   ${statusText(row, state.now)}`),
    );
    if (device.attachedSession) field("Session", device.attachedSession);
    if (device.size) field("Screen", `${device.size.cols}×${device.size.rows}`);
    field("Can do", capabilities(device));
    if (device.expiresAt) {
      field(
        "Expires",
        device.expiresAt <= state.now
          ? "already — it is running on a spent grant"
          : `in ${since(state.now, device.expiresAt)}`,
      );
    }
    field("Reached me", whereFrom(device));
    if (device.userAgent) field("It says", sanitizeLabel(device.userAgent));
  } else {
    field("Connected", "not right now");
  }

  if (row.peer) {
    field("Paired", `${since(row.peer.pairedAt, state.now)} ago`);
    field(
      "Last seen",
      row.peer.expired
        ? "over 90 days ago — it must pair again"
        : `${since(row.peer.lastSeenAt, state.now)} ago`,
    );
  } else if (device) {
    // A live socket with no stored record: the machine's own token, or a
    // share. Worth naming, because `r` is about to be missing from the footer.
    field("Paired", "no — it is using this machine's own token");
  }

  // The device id is what `mtmux devices revoke` takes, so it is printed in
  // full rather than shortened — a truncated id is a thing you cannot act on.
  if (row.deviceId) field("Device", row.deviceId);
  if (device?.id) field("Socket", device.id);

  lines.push("");
  // Fitted like every other line here: at 40 columns the hint is what goes,
  // not the keys, because the keys are the part you cannot guess.
  const parts: string[] = [];
  if (device) parts.push(`${kleur.bold("c")} ${kleur.dim("close")}`);
  if (row.deviceId) {
    parts.push(`${kleur.bold("e")} ${kleur.dim("rename")}`);
    parts.push(`${kleur.bold("r")} ${kleur.dim("revoke")}`);
  }
  parts.push(kleur.dim("any other key goes back"));
  lines.push(` ${fit(parts.join(kleur.dim("   ·   ")), width - 2)}`);
  return lines;
}

/** The grant in one line: reach, then write access, then files. */
function capabilities(device: ConnectedDevice): string {
  const parts: string[] = [];
  if (!device.scope || device.scope.kind === "all") parts.push("every session");
  else if (device.scope.kind === "sessions") {
    parts.push(
      device.scope.sessions.length === 1
        ? `only ${device.scope.sessions[0]}`
        : `only ${device.scope.sessions.join(", ")}`,
    );
  } else parts.push(`${device.scope.count} recording(s)`);

  parts.push(device.readOnly ? "watch only" : "type into it");

  if (device.files === "none") parts.push("no files");
  else if (device.files === "read") parts.push("read files");
  else if (device.files === "write") parts.push("read and write files");

  return parts.join("   ·   ");
}

/**
 * How the socket arrived, said plainly.
 *
 * This deliberately does not guess from the address. A tunnelled connection
 * and a browser on this very machine both come from loopback, and the only
 * thing that separates them is the tunnel agent's own user-agent header at the
 * upgrade — which the relay classifies there and carries through as
 * `transport`. Reading the address here would produce a confident wrong answer
 * for the case people most want to know about.
 */
function whereFrom(device: ConnectedDevice): string {
  const address = device.remoteAddress?.replace(/^::ffff:/, "") ?? null;
  switch (device.transport) {
    case "tunnel":
      return "through the encrypted tunnel";
    case "lan":
      return `over this network${address ? ` from ${address}` : ""}`;
    case "loopback":
      return "from this machine";
    default:
      // An older relay bundle with no `transport`. The address is all there is,
      // and it is said as an address rather than dressed up as a conclusion.
      return address ?? "unknown";
  }
}

function key(k: string, label: string): string {
  return `${kleur.bold(k)} ${kleur.dim(label)}`;
}

function help(state: PanelState, width: number): string[] {
  const lines = [
    rule(width),
    ` ${kleur.bold("Keys")}`,
    `   ${kleur.bold("↑ ↓")}   ${kleur.dim("move between devices — connected first, then paired")}`,
    `   ${kleur.bold("d")}     ${kleur.dim("everything about this device — enter does it too")}`,
    `   ${kleur.bold("c")}     ${kleur.dim("close this connection — it may reconnect")}`,
    `   ${kleur.bold("e")}     ${kleur.dim("rename it, so the list reads as yours")}`,
    `   ${kleur.bold("r")}     ${kleur.dim("revoke this device — permanent, it must pair again")}`,
    `   ${kleur.bold("a")}     ${kleur.dim("ask again when a device you know comes back")}`,
    `   ${kleur.bold("t")}     ${kleur.dim("open an encrypted tunnel, so a device anywhere can pair")}`,
    `   ${kleur.bold("n")}     ${kleur.dim("throw away the printed code and arm a fresh one")}`,
    `   ${kleur.bold("l")}     ${kleur.dim("reprint the banner, code and addresses")}`,
    `   ${kleur.bold("q")}     ${kleur.dim("stop the server — the same as Ctrl+C")}`,
    "",
    ` ${kleur.dim("Closing is temporary, revoking is not. Renaming changes nothing")}`,
    ` ${kleur.dim("about what a device may do — it is for you, not for it.")}`,
    "",
    ` ${kleur.dim("A new device is always asked about here before it gets in.")}`,
    ` ${kleur.dim("Asking again when a known one returns is ")}` +
      (state.askOnReconnect ? kleur.bold("on") : kleur.dim("off")) +
      kleur.dim(` — press a.`),
    "",
    ` ${kleur.dim("t and n are never both offered: t opens the tunnel this machine")}`,
    ` ${kleur.dim("does not have, n replaces a code it already printed.")}`,
    ` ${kleur.dim("Any key to go back.")}`,
  ];
  return lines.map((line) => fit(line, width));
}

function confirm(
  mode: Extract<PanelMode, { kind: "confirm" }>,
  width: number,
): string[] {
  return [
    rule(width),
    ` ${kleur.bold("Revoke")} ${kleur.bold(kleur.yellow(sanitizeLabel(mode.label)))}${kleur.bold("?")}`,
    ` ${kleur.dim("It is disconnected now and must pair again to come back.")}`,
    ` ${kleur.dim("To hang up without un-pairing, answer no and press")} ${kleur.bold("c")}${kleur.dim(".")}`,
    "",
    ` ${kleur.bold("y")} ${kleur.dim("revoke")}   ${kleur.bold("n")} ${kleur.dim("keep it paired")}`,
  ];
}

/**
 * The rename editor.
 *
 * A line editor rather than a readline, for the reason the whole panel exists:
 * one owner of stdin. Opening a readline here would put two readers on the
 * same tty, which is the defect `access-prompt.ts` records paying for once.
 *
 * Empty and Enter clears the name back to whatever the browser calls itself,
 * which is the only way back and is said on screen rather than left to be
 * discovered.
 */
function rename(
  mode: Extract<PanelMode, { kind: "rename" }>,
  width: number,
): string[] {
  return [
    rule(width),
    ` ${kleur.bold("Rename")} ${kleur.bold(kleur.cyan(fit(sanitizeLabel(mode.label), Math.max(8, width - 12))))}`,
    "",
    ` ${kleur.dim("Name")}  ${kleur.bold(fit(mode.draft, Math.max(8, width - 10)))}${kleur.cyan("▏")}`,
    "",
    // Fitted, like every other prose line in this file. A 40-column terminal
    // is the width this panel is tested at and these two sentences are the
    // longest strings it draws.
    ` ${kleur.dim(fit("Enter saves   ·   empty clears it back to what the browser says", width - 2))}`,
    ` ${kleur.dim(fit("Esc cancels   ·   it changes nothing about what the device may do", width - 2))}`,
  ];
}

/**
 * The approval question, in the panel rather than in a readline.
 *
 * Two readers on one stdin is the defect `access-prompt.ts` records paying
 * for — "a dead `[y/N]` eating keystrokes on the machine" after the question
 * was answered elsewhere. So when the panel is up it *is* the prompt: it
 * supplies `decideAccess`'s `prompt` seam and answers with the same key reader
 * that drives everything else. One owner of stdin, always.
 */
function approval(
  state: PanelState,
  mode: Extract<PanelMode, { kind: "approval" }>,
  width: number,
): string[] {
  const left = Math.max(0, Math.ceil((mode.expiresAt - state.now) / 1000));
  const lines = [
    rule(width),
    ` ${kleur.bold(kleur.yellow("A device wants in"))}`,
    // Stripped at the render site as well as at ingress. This is the one
    // strong human gate in the product, and a label that can move the cursor
    // can erase the question and draw a friendlier one.
    ` ${kleur.dim("Device ")}  ${sanitizeLabel(mode.label)}`,
  ];
  if (mode.account) {
    lines.push(` ${kleur.dim("Account")}  ${sanitizeLabel(mode.account)}`);
  }
  if (mode.sas) {
    lines.push(` ${kleur.dim("Code   ")}  ${kleur.bold(mode.sas)}`);
    lines.push(
      ` ${kleur.dim("It is showing the same six digits. Deny if they differ.")}`,
    );
  } else {
    // No digits, and the absence is the message. The code was the shared
    // secret, so there is nothing to compare; asking "do these match?"
    // against a blank space teaches people to answer without looking.
    lines.push(
      ` ${kleur.dim("It entered this machine's code. Say yes only if that was you.")}`,
    );
  }
  lines.push("");
  lines.push(
    ` ${kleur.bold("y")} ${kleur.dim("let it in")}   ${kleur.bold("n")} ${kleur.dim("refuse")}` +
      kleur.dim(`   ·   ${left}s left, and doing nothing refuses it`),
  );
  return lines;
}

export function clamp(cursor: number, length: number): number {
  if (length === 0) return 0;
  return Math.min(Math.max(0, cursor), length - 1);
}

export function selected(state: PanelState): PanelRow | null {
  return state.rows[clamp(state.cursor, state.rows.length)] ?? null;
}
