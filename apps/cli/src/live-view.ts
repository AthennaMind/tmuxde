import kleur from "kleur";

/**
 * The bottom of the screen, and the one thing allowed to move the cursor.
 *
 * ## Why this exists at all
 *
 * `mtmux start` used to print a banner and then append lines forever — "✓
 * iPhone connected", "· iPhone disconnected", one after another. The comment
 * on `watchConnectedDevices` explained the choice honestly: the banner already
 * owned the bottom of the screen through `waitingLineOnScreen`, and "a second
 * writer moving the cursor would corrupt the QR the moment the two coincided".
 *
 * That reasoning is correct and the conclusion it reached — append-only — was
 * the right call *given one more writer*. It stops being the right call once
 * there is a single writer that owns the region, which is what this is. Every
 * line the command prints now goes through `log()`, the panel is redrawn after
 * it, and nothing else touches the cursor. The invariant is not "do not
 * repaint", it is "exactly one thing repaints".
 *
 * ## The scroll model
 *
 * The panel lives at the bottom, below everything already printed. To write a
 * log line we erase the panel, write the line (the terminal scrolls normally),
 * then draw the panel again. So scrollback contains only log lines — a panel
 * from four minutes ago is never left stranded in the history, which is the
 * failure mode of every status bar that draws itself with plain `console.log`.
 *
 * ## What happens off a TTY
 *
 * Nothing. `enabled` is false for a pipe, a service unit, `--json`, or a
 * terminal too short to hold a panel, and `log()` degrades to `console.log`.
 * That is not a fallback bolted on afterwards; it is the same path the command
 * took before this file existed, which is why a systemd unit's journal still
 * reads as a plain append-only log.
 */

/** Rows we refuse to take from a small terminal, so content is never hidden. */
const MIN_ROWS_FOR_PANEL = 12;

export type LiveViewDeps = {
  out?: NodeJS.WriteStream;
  /** Force the panel on or off, for tests. Defaults to "on if it is a TTY". */
  enabled?: boolean;
};

export type LiveView = {
  /** True when the panel is being drawn. False means this is a plain logger. */
  readonly enabled: boolean;
  /** Print above the panel. The only sanctioned way to write to the screen. */
  log: (...lines: string[]) => void;
  /**
   * Set what the panel shows. `null` removes it.
   *
   * A function rather than an array so the panel can re-render itself on a
   * resize without the caller having to notice one happened.
   */
  setPanel: (render: ((columns: number) => string[]) | null) => void;
  /** Redraw now, for a panel whose content changed underneath it. */
  refresh: () => void;
  /** Erase the panel and stop listening. Idempotent. */
  stop: () => void;
};

export function createLiveView(deps: LiveViewDeps = {}): LiveView {
  const out = deps.out ?? process.stdout;
  const enabled =
    deps.enabled ??
    (out.isTTY === true && (out.rows ?? 0) >= MIN_ROWS_FOR_PANEL);

  let render: ((columns: number) => string[]) | null = null;
  /** How many rows the panel currently occupies on screen. */
  let drawn = 0;
  let stopped = false;

  const columns = () => Math.max(40, out.columns ?? 80);

  function erase(): void {
    if (drawn === 0) return;
    // Up to the first panel row, then clear everything below the cursor. One
    // escape for the whole block: clearing line-by-line flickers, and on a
    // slow link it flickers visibly.
    out.write(`\x1b[${drawn}A\x1b[0J`);
    drawn = 0;
  }

  function draw(): void {
    if (!enabled || stopped || !render) return;
    const lines = render(columns());
    if (lines.length === 0) return;
    out.write(`${lines.join("\n")}\n`);
    drawn = lines.length;
  }

  function onResize(): void {
    if (!enabled || stopped) return;
    // The old panel was laid out for the old width and its wrapped rows no
    // longer match `drawn`, so erasing by row count would eat real output.
    // Give up the region instead and draw fresh below whatever is there.
    drawn = 0;
    draw();
  }

  if (enabled) out.on("resize", onResize);

  return {
    get enabled() {
      return enabled;
    },
    log(...lines: string[]) {
      if (!enabled || stopped) {
        for (const line of lines) console.log(line);
        return;
      }
      erase();
      for (const line of lines) out.write(`${line}\n`);
      draw();
    },
    setPanel(next) {
      if (!enabled || stopped) return;
      erase();
      render = next;
      draw();
    },
    refresh() {
      if (!enabled || stopped) return;
      erase();
      draw();
    },
    stop() {
      if (stopped) return;
      stopped = true;
      if (!enabled) return;
      out.off("resize", onResize);
      erase();
    },
  };
}

/**
 * Cut a string to `width` columns, by display width and not by `.length`.
 *
 * A device label is whatever the browser's user agent said, so it routinely
 * carries characters that are two columns wide or zero. Slicing by code unit
 * puts the panel's columns out by however many of those a label happened to
 * contain, and the table stops being a table.
 */
export function fit(text: string, width: number): string {
  if (width <= 0) return "";
  let used = 0;
  let out = "";
  for (const ch of text) {
    const w = charWidth(ch);
    if (used + w > width) {
      // Leave room for the ellipsis, which is itself one column.
      while (used >= width && out.length > 0) {
        const last = [...out].at(-1)!;
        out = out.slice(0, -last.length);
        used -= charWidth(last);
      }
      return `${out}…`;
    }
    out += ch;
    used += w;
  }
  return out;
}

/** Pad to `width` display columns. Companion to `fit`, same width rules. */
export function pad(text: string, width: number): string {
  const cut = fit(text, width);
  return cut + " ".repeat(Math.max(0, width - displayWidth(cut)));
}

export function displayWidth(text: string): number {
  let total = 0;
  for (const ch of text) total += charWidth(ch);
  return total;
}

/**
 * Wide, zero, or one.
 *
 * Deliberately a small table rather than a dependency. The panel shows device
 * labels, session names and a handful of glyphs we choose ourselves; a full
 * Unicode width database would be a lot of weight to carry so that a user
 * agent string containing a Hangul syllable lines up. The ranges below are the
 * ones that actually turn up — CJK, Hangul, and the emoji planes — and
 * combining marks, which are the other half of the same mistake.
 */
function charWidth(ch: string): number {
  const cp = ch.codePointAt(0) ?? 0;
  // Combining marks and zero-width joiners take no space of their own.
  if ((cp >= 0x0300 && cp <= 0x036f) || cp === 0x200d || cp === 0xfe0f)
    return 0;
  if (cp < 0x1100) return 1;
  if (
    (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
    (cp >= 0x2e80 && cp <= 0xa4cf) || // CJK radicals … Yi
    (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul syllables
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK compatibility ideographs
    (cp >= 0xfe30 && cp <= 0xfe6f) || // CJK compatibility forms
    (cp >= 0xff00 && cp <= 0xff60) || // Fullwidth forms
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) || // Emoji
    (cp >= 0x1f900 && cp <= 0x1f9ff)
  ) {
    return 2;
  }
  return 1;
}

/** "3m", "2h", "4d" — the coarsest unit that is still true. */
export function since(from: number, now: number): string {
  const secs = Math.max(0, Math.round((now - from) / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

/** A dim rule the full width of the panel, used as its top edge. */
export function rule(width: number): string {
  return kleur.dim("─".repeat(Math.max(0, width)));
}
