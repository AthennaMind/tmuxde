import kleur from "kleur";
import qrcode from "qrcode-terminal";
import { formatCodeForDisplay } from "@repo/crypto";

/**
 * What `mtmux start` prints.
 *
 * The banner has one job: get a phone into the session. Everything competes for
 * the same few lines of attention, so the layout is ordered by how likely a
 * given reader is to use it — scan the code, or type the code, or open a local
 * URL — and anything that is merely *available* (the auth token, the interface
 * name) is demoted or dropped entirely.
 */

export type PairingInvite = {
  /**
   * The digits to type. Rendered grouped, never as one run.
   *
   * Null once the typed half has stopped arming — the two halves have separate
   * failure budgets and separate slot spaces, so a sweep that kills the typed
   * code leaves the QR beside it perfectly good. A banner that could only draw
   * both or neither would blank a working QR.
   */
  code: string | null;
  /** What the QR encodes: the join URL with the code in the fragment. */
  url: string | null;
  /** Origin shown to someone typing the code by hand, e.g. "app.mtmux.com". */
  host: string;
};

export type BannerOpts = {
  version: string;
  /** Always-correct loopback URL for the machine running the server. */
  localUrl: string;
  /** Reachable LAN URL, or null when bound to loopback / there is no network. */
  lanUrl?: string | null;
  /** Interface the LAN address came from, e.g. "wlp3s0". */
  lanInterface?: string | null;
  /**
   * The hosted invite, when the tunnel is up. Null in `--local` mode, and also
   * when the broker could not be reached — in which case `note` explains why.
   */
  invite?: PairingInvite | null;
  /**
   * A LAN sign-in URL to encode instead, used in `--local` mode. Ignored when
   * `invite` is set.
   */
  lanQrPayload?: string | null;
  /**
   * Draw the QR block. `--no-qr` clears this and the code is still printed —
   * the two are separate because a terminal that mangles block characters can
   * still relay nine digits perfectly well.
   */
  showQr?: boolean;
  /**
   * This machine's relay token, for signing a device in by hand.
   *
   * Printed whenever there is no pairing code — see the block that renders it
   * for why "there is a QR" is not a good enough reason to withhold it.
   */
  token?: string;
  /** A dim line under the addresses — degradation notices go here. */
  note?: string | null;
  /**
   * How to do the thing this run deliberately did not do.
   *
   * Separate from `note` because the two say opposite things: a note explains
   * that something went wrong, a hint explains that nothing did and here is
   * the next step. Printed under the note when both are present, which is the
   * order they read in — what happened, then what to do about it.
   */
  hint?: string | null;
  /** Terminal width; injectable so the layout can be tested. */
  columns?: number;
};

const GAP = "   ";
const INDENT = "  ";
const ANSI = /\[[0-9;]*m/g;

/**
 * The one claim about the hosted path worth the lines it costs.
 *
 * Every other terminal-in-a-browser asks you to believe its servers. This one
 * does not have to be believed: the nine digits are a CPace password that
 * never reaches the broker, the session key is derived on the two endpoints,
 * and every frame after it is AES-256-GCM. The broker routes ciphertext it
 * cannot open. That is the product, and the banner — the one surface people
 * actually read — was the one place that never said so.
 *
 * Worded as what it means rather than as what it is. "CPace PAKE over
 * ristretto255" is true and persuades nobody who is not already persuaded.
 *
 * Wrapped by hand at 26 columns, because this sits beside the QR and
 * `twoColumn` stacks the two the moment they will not fit side by side. A long
 * line here would push a wide terminal into the narrow layout.
 */
const SEALED = [
  kleur.dim("Sealed end to end — we"),
  kleur.dim("pass it on, we can't"),
  kleur.dim("read it."),
];

/** The other half of the same honesty: local mode is not the tunnel. */
const LOCAL_ONLY = [
  kleur.dim("On this network only. The"),
  kleur.dim("link signs the device in —"),
  kleur.dim("nothing reaches our"),
  kleur.dim("servers."),
];

/**
 * qrcode-terminal draws *light* modules as foreground blocks and dark modules
 * as the background. That is only the right way round on a dark terminal, and a
 * polarity-inverted QR is a coin flip across scanner apps. Pinning bright white
 * on black makes the code render identically under any terminal theme.
 */
function colorizeQr(lines: string[]): string[] {
  if (!kleur.enabled) return lines;
  return lines.map((line) => `[97;40m${line}[0m`);
}

/** Render a QR for `text` as plain lines, blank rows trimmed. */
export function qrLines(text: string): string[] {
  let out = "";
  // qrcode-terminal's callback is synchronous despite the shape.
  qrcode.generate(text, { small: true }, (rendered: string) => {
    out = rendered;
  });
  return out.split("\n").filter((line) => line.trim().length > 0);
}

/** Visible width, ignoring ANSI colour and counting astral chars once. */
function width(line: string): number {
  return [...line.replace(ANSI, "")].length;
}

/**
 * Zip a QR column and a text column side by side, stacking them instead when
 * the terminal is too narrow to hold both.
 *
 * The QR leads because it is the fastest path in and it is the one element
 * whose size is fixed — the prose beside it can wrap or be dropped, the code
 * cannot shrink.
 */
function twoColumn(left: string[], right: string[], columns: number): string[] {
  if (left.length === 0) return right;
  if (right.length === 0) return left;

  const leftWidth = Math.max(...left.map(width), 0);
  const rightWidth = Math.max(...right.map(width), 0);

  if (INDENT.length + leftWidth + GAP.length + rightWidth > columns) {
    return [...left, "", ...right];
  }

  // Centre the shorter column against the taller one, which is almost always
  // the prose against the QR. Left-aligning it hangs the text off the top edge.
  const rows = Math.max(left.length, right.length);
  const rightPad = Math.max(0, Math.floor((rows - right.length) / 2));

  const out: string[] = [];
  for (let i = 0; i < rows; i++) {
    const l = left[i] ?? "";
    const r = right[i - rightPad];
    if (r === undefined) {
      out.push(l);
      continue;
    }
    out.push(l + " ".repeat(Math.max(0, leftWidth - width(l))) + GAP + r);
  }
  return out;
}

/** `482913` → `48 2913`, so it can be read aloud and typed without losing place. */
function renderCode(code: string): string {
  return formatCodeForDisplay(code);
}

function addressBlock(opts: BannerOpts): string[] {
  const rows: [string, string, string][] = [
    ["Local", opts.localUrl, ""],
    ...(opts.lanUrl
      ? ([["Network", opts.lanUrl, opts.lanInterface ?? ""]] as [
          string,
          string,
          string,
        ][])
      : []),
  ];
  const labelWidth = Math.max(...rows.map(([label]) => label.length));
  return rows.map(
    ([label, url, iface]) =>
      INDENT +
      kleur.dim(label.padEnd(labelWidth)) +
      "  " +
      url +
      (iface ? kleur.dim(`  (${iface})`) : ""),
  );
}

export function renderBannerLines(opts: BannerOpts): string[] {
  const columns = opts.columns ?? process.stdout.columns ?? 80;
  const brand = kleur.red;

  const out: string[] = [
    "",
    INDENT + brand().bold("›  mtmux") + kleur.dim(`  ${opts.version}`),
    "",
  ];

  const qrPayload = opts.invite ? opts.invite.url : (opts.lanQrPayload ?? null);
  const showQr = opts.showQr !== false && qrPayload !== null;
  const qr = showQr ? colorizeQr(qrLines(qrPayload!)) : [];

  const aside: string[] = [];
  const typedCode = opts.invite?.code ?? null;
  if (opts.invite && typedCode) {
    aside.push(
      kleur.bold(showQr ? "Scan to open your terminal" : "Open your terminal"),
    );
    aside.push("");
    aside.push(
      // Both arms are ten columns wide, so `app.mtmux.com` and the code below
      // it start in the same place. "Go to    " was nine, which left the
      // --no-qr banner — the one people read *because* the QR is not there —
      // with its two answers a character out of line.
      kleur.dim(showQr ? "or go to  " : "Go to     ") + brand(opts.invite.host),
    );
    aside.push(kleur.dim("and enter ") + kleur.bold(renderCode(typedCode)));
    aside.push("");
    aside.push(...SEALED);
  } else if (opts.invite && showQr) {
    // The typed half is spent but the QR is not. Say what is left rather than
    // pointing at a code that no longer exists.
    aside.push(kleur.bold("Scan to open your terminal"));
    aside.push("");
    aside.push(kleur.dim("There is no code to type"));
    aside.push(kleur.dim("for this one."));
    aside.push("");
    aside.push(...SEALED);
  } else if (opts.lanQrPayload && showQr) {
    aside.push(kleur.bold("Scan to open your terminal"));
    aside.push("");
    aside.push(...LOCAL_ONLY);
  }

  if (qr.length > 0) {
    out.push(
      ...twoColumn(
        qr.map((line) => INDENT + line),
        aside,
        columns,
      ),
    );
    out.push("");
  } else if (aside.length > 0) {
    // Indent only lines that have something on them: an indented empty string
    // is two trailing spaces, invisible in a terminal and very visible in a
    // README code fence or a `git diff`.
    out.push(...aside.map((line) => (line ? INDENT + line : "")));
    out.push("");
  }

  out.push(...addressBlock(opts));

  if (opts.note) {
    out.push("");
    out.push(INDENT + kleur.dim(opts.note));
  }

  if (opts.hint) {
    out.push("");
    out.push(INDENT + kleur.dim(opts.hint));
  }

  /*
   * The token, and why it is back on screen.
   *
   * It used to be printed only when there was neither a code to type nor one
   * to scan, on the reasoning that it is a 64-character secret and a QR beside
   * it is the better answer. The first half of that is still true. The second
   * half quietly assumed every device can scan, and the banner then told the
   * one that cannot — a laptop on the same wifi, a phone with no camera
   * permission, anyone reading this over SSH — that there was "no token to
   * type", which was not a demotion but a dead end.
   *
   * So: printed whenever this run has no pairing code, which is exactly when
   * it is the only credential a second device can use by hand. `/login` takes
   * it pasted. A hosted invite still suppresses it — nine digits that expire
   * beat a permanent secret, and printing both invites the wrong one to be
   * copied.
   */
  if (!opts.invite && opts.token) {
    out.push("");
    out.push(
      INDENT +
        kleur.dim(
          showQr
            ? "Can't scan? Open an address above and paste this token:"
            : "Open an address above and paste this token to sign in:",
        ),
    );
    out.push(INDENT + kleur.dim(opts.token));
  }

  out.push("");
  out.push(
    INDENT +
      kleur.dim(opts.invite ? "Waiting for a device…" : "Ready.") +
      kleur.dim("   Ctrl+C to stop."),
  );
  out.push("");

  return out;
}

export function banner(opts: BannerOpts) {
  for (const line of renderBannerLines(opts)) console.log(line);
}
