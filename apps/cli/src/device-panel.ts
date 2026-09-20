import kleur from "kleur";

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
 * ## The two verbs, kept apart on purpose
 *
 * `c` closes a socket. The credential stays valid and the browser may come
 * back; it is "hang up", for the tab you left open somewhere else.
 * `r` revokes the device. That is permanent and it un-pairs.
 *
 * Both are offered, and they are offered together, precisely so that nobody
 * reaches for the permanent one to solve a temporary problem — which is what
 * happens when the only tool in reach is `mtmux devices revoke`. Revoke asks
 * for confirmation and close does not, because the cost of a wrong close is
 * one reconnect and the cost of a wrong revoke is pairing again from scratch.
 *
 * ## Rendering rules
 *
 * Pure. `render()` takes a width and some state and returns lines; it never
 * writes, never measures the terminal and never reads the clock except through
 * the `now` it is handed. That is what lets the whole panel be asserted as
 * strings in a test, which is the only practical way to check a layout that
 * has to survive a 40-column terminal and a label full of emoji.
 */

export type PanelMode =
  | { kind: "list" }
  | { kind: "help" }
  /** A destructive action waiting on y/n, holding what it will act on. */
  | { kind: "confirm"; action: "revoke"; id: string; label: string }
  /** A device is asking to be let in. Nothing else is reachable until it is answered. */
  | {
      kind: "approval";
      label: string;
      account: string;
      sas?: string;
      expiresAt: number;
    };

export type PanelState = {
  devices: ConnectedDevice[];
  /** Index into `devices`. Clamped at render, never trusted. */
  cursor: number;
  mode: PanelMode;
  /** Shown under the table for a few seconds after an action. */
  flash: string | null;
  now: number;
  /** Whether a tunnel is up, which decides if `n` can mean anything. */
  hosted: boolean;
  /** Set while the panel cannot act — during shutdown. */
  frozen: boolean;
};

/** Longest a flash line stays before the panel forgets it. */
export const FLASH_MS = 4000;

/** Rows the table gives to devices before it starts saying "+N more". */
const MAX_ROWS = 8;

export function render(state: PanelState, columns: number): string[] {
  const width = Math.max(40, columns);
  switch (state.mode.kind) {
    case "approval":
      return approval(state, state.mode, width);
    case "help":
      return help(width);
    case "confirm":
      return confirm(state.mode, width);
    default:
      return list(state, width);
  }
}

function list(state: PanelState, width: number): string[] {
  const lines = [rule(width)];
  const count = state.devices.length;

  lines.push(
    ` ${kleur.bold(headline(count))}` +
      (state.hosted ? kleur.dim("   ·   tunnel up") : ""),
  );

  if (count === 0) {
    // Not an empty table. A header row over nothing reads as a bug, and the
    // useful thing to say here is what to do next rather than what is absent.
    lines.push(
      kleur.dim(
        state.hosted
          ? "  Scan the code above, or press n for a fresh one."
          : "  Open the address above on a device on this network.",
      ),
    );
  } else {
    const shown = state.devices.slice(0, MAX_ROWS);
    const cursor = clamp(state.cursor, shown.length);
    shown.forEach((device, i) => {
      lines.push(row(device, i === cursor, state.now, width));
    });
    if (count > shown.length) {
      lines.push(kleur.dim(`  … and ${count - shown.length} more`));
    }
  }

  if (state.flash) lines.push(` ${state.flash}`);
  lines.push(keyBar(state, width));
  return lines;
}

function headline(count: number): string {
  if (count === 0) return "Nothing connected";
  return `${count} device${count === 1 ? "" : "s"} connected`;
}

/**
 * One device.
 *
 * The widths are computed from the terminal rather than fixed, because the
 * label is the only field whose length is not ours — it is whatever the
 * browser's user agent produced — and a fixed layout either truncates it to
 * uselessness at 120 columns or overflows at 60.
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
function row(
  device: ConnectedDevice,
  isSelected: boolean,
  now: number,
  width: number,
): string {
  const AGE_W = 4;
  const IDLE_W = 9;
  const WHERE_W = 14;

  const age = pad(since(device.connectedAt, now), AGE_W);
  const idle =
    device.lastActivityAt === undefined
      ? pad("", IDLE_W)
      : pad(idleText(device.lastActivityAt, now), IDLE_W);
  const tag = badge(device);
  const showWhere = width >= 64;
  const where = showWhere ? pad(sessionText(device), WHERE_W) : null;

  // " " + marker + " " … then one space before each remaining field.
  const spent =
    3 +
    (where ? WHERE_W + 1 : 0) +
    AGE_W +
    1 +
    IDLE_W +
    1 +
    displayWidth(stripAnsi(tag));
  const label = pad(device.label, Math.max(6, width - spent));

  const marker = isSelected ? kleur.cyan("▸") : " ";
  const name = isSelected ? kleur.bold(label) : label;
  const middle = where ? ` ${kleur.dim(where)}` : "";
  return ` ${marker} ${name}${middle} ${kleur.dim(age)} ${kleur.dim(idle)}${tag}`;
}

/**
 * Measure a coloured string as the terminal will.
 *
 * `badge()` returns text wrapped in escapes, and counting those as columns
 * would steal ten of them from the label on every read-only row.
 */
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function idleText(lastActivityAt: number, now: number): string {
  const quiet = now - lastActivityAt;
  // Under ten seconds is "now" rather than a number that changes every render
  // and draws the eye to a connection doing nothing interesting.
  return quiet < 10_000 ? "live" : `idle ${since(lastActivityAt, now)}`;
}

function sessionText(device: ConnectedDevice): string {
  if (device.attachedSession) return device.attachedSession;
  if (device.scope?.kind === "sessions") {
    return device.scope.sessions.join(",") || "—";
  }
  if (device.scope?.kind === "recordings") return "recordings";
  return "—";
}

/** The one thing worth colouring: a connection that is not a full session. */
function badge(device: ConnectedDevice): string {
  if (device.readOnly) return kleur.yellow(" read-only");
  if (device.scope && device.scope.kind !== "all") return kleur.cyan(" shared");
  return "";
}

function keyBar(state: PanelState, width: number): string {
  const keys: string[] = [];
  if (state.devices.length > 1) keys.push(key("↑↓", "select"));
  if (state.devices.length > 0) {
    keys.push(key("c", "close"));
    // Only when there is a device behind the socket. The machine's own token
    // has none, and offering to revoke it would offer to revoke the credential
    // this terminal is printing.
    if (selected(state)?.deviceId) keys.push(key("r", "revoke"));
  }
  if (state.hosted) keys.push(key("n", "new code"));
  keys.push(key("?", "help"), key("q", "quit"));
  return ` ${fit(keys.join(kleur.dim("   ")), width - 2)}`;
}

function key(k: string, label: string): string {
  return `${kleur.bold(k)} ${kleur.dim(label)}`;
}

function help(width: number): string[] {
  return [
    rule(width),
    ` ${kleur.bold("Keys")}`,
    `   ${kleur.bold("↑ ↓")}   ${kleur.dim("move between connected devices")}`,
    `   ${kleur.bold("c")}     ${kleur.dim("close this connection — it may reconnect")}`,
    `   ${kleur.bold("r")}     ${kleur.dim("revoke this device — permanent, it must pair again")}`,
    `   ${kleur.bold("n")}     ${kleur.dim("throw away the printed code and arm a fresh one")}`,
    `   ${kleur.bold("l")}     ${kleur.dim("reprint the banner, code and addresses")}`,
    `   ${kleur.bold("q")}     ${kleur.dim("stop the server — the same as Ctrl+C")}`,
    "",
    ` ${kleur.dim("Closing is temporary, revoking is not. mtmux devices lists every")}`,
    ` ${kleur.dim("paired device, including the ones not connected right now.")}`,
    ` ${kleur.dim("Any key to go back.")}`,
  ];
}

function confirm(
  mode: Extract<PanelMode, { kind: "confirm" }>,
  width: number,
): string[] {
  return [
    rule(width),
    ` ${kleur.bold("Revoke")} ${kleur.bold(kleur.yellow(mode.label))}${kleur.bold("?")}`,
    ` ${kleur.dim("It is disconnected now and must pair again to come back.")}`,
    ` ${kleur.dim("To hang up without un-pairing, answer no and press")} ${kleur.bold("c")}${kleur.dim(".")}`,
    "",
    ` ${kleur.bold("y")} ${kleur.dim("revoke")}   ${kleur.bold("n")} ${kleur.dim("keep it paired")}`,
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
    ` ${kleur.dim("Device ")}  ${mode.label}`,
  ];
  if (mode.account) lines.push(` ${kleur.dim("Account")}  ${mode.account}`);
  if (mode.sas) {
    lines.push(` ${kleur.dim("Code   ")}  ${kleur.bold(mode.sas)}`);
    lines.push(
      ` ${kleur.dim("It is showing the same six digits. Deny if they differ.")}`,
    );
  } else {
    // No digits, and the absence is the message. The nine-digit code was the
    // shared secret, so there is nothing to compare; asking "do these match?"
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

export function selected(state: PanelState): ConnectedDevice | null {
  return state.devices[clamp(state.cursor, state.devices.length)] ?? null;
}
