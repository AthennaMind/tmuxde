/**
 * Single-keypress input for the live panel, and the small print that comes
 * with taking a terminal out of line mode.
 *
 * ## What raw mode costs, and why it is paid here
 *
 * In cooked mode the tty turns Ctrl+C into SIGINT before Node ever sees it. In
 * raw mode it does not: the byte 0x03 arrives as input and *nothing else
 * happens*. Every program that forgets this ships a terminal you cannot quit,
 * and `mtmux start` is a long-running foreground process, so that would not be
 * a rough edge — it would be the worst bug in the product.
 *
 * So the interrupt keys are handled first, before any user binding gets a
 * look, and they are not overridable. `onInterrupt` is wired to the same
 * `shutdown()` that `process.on("SIGINT")` calls, which means Ctrl+C does
 * exactly what it did before this file existed.
 *
 * Restoration is belt and braces for the same reason. `stop()` restores, and
 * so does a `process.on("exit")` hook, because the paths out of a Node process
 * that skip your cleanup — a throw in a handler, `process.exit` from somewhere
 * else — are exactly the paths where leaving the tty in raw mode hands the
 * user a shell with no echo and no line editing. `exit` fires on all of them.
 *
 * ## Why not readline
 *
 * `access-prompt.ts` already opens a readline on stdin for the approval
 * question, and two readers on one stdin is the defect that file's header
 * describes paying for once: "a dead `[y/N]` eating keystrokes on the machine"
 * after the question had been answered elsewhere. The answer is not a second
 * careful reader, it is one reader — so when the panel is up it owns stdin and
 * supplies `decideAccess`'s `prompt` seam itself.
 */

export type KeyHandler = (key: string) => void;

export type KeyReaderDeps = {
  input?: NodeJS.ReadStream;
  /** Force on or off. Defaults to "on if stdin is a TTY". */
  enabled?: boolean;
  /** Ctrl+C or Ctrl+D. Not overridable, and always runs first. */
  onInterrupt: () => void;
};

export type KeyReader = {
  readonly enabled: boolean;
  /** Replace the handler. The panel swaps this when it changes mode. */
  setHandler: (handler: KeyHandler | null) => void;
  stop: () => void;
};

/** Ctrl+C and Ctrl+D, the two bytes that must never reach a binding. */
const INTERRUPT = new Set(["", ""]);

export function createKeyReader(deps: KeyReaderDeps): KeyReader {
  const input = deps.input ?? process.stdin;
  const enabled = deps.enabled ?? input.isTTY === true;
  if (!enabled) {
    return { enabled: false, setHandler: () => {}, stop: () => {} };
  }

  let handler: KeyHandler | null = null;
  let stopped = false;

  const onData = (chunk: Buffer | string) => {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    // A paste or a held key arrives as one chunk of several characters. Split
    // it, because dropping all but the first silently loses input and taking
    // the whole chunk as one "key" matches no binding at all.
    for (const key of splitKeys(text)) {
      if (INTERRUPT.has(key)) {
        deps.onInterrupt();
        return;
      }
      handler?.(key);
    }
  };

  const restore = () => {
    if (stopped) return;
    stopped = true;
    input.off("data", onData);
    try {
      input.setRawMode?.(false);
    } catch {
      // The tty went away underneath us — a closed terminal, a killed pane.
      // There is nothing left to restore and nothing useful to say about it.
    }
    input.pause();
    process.off("exit", restore);
  };

  try {
    input.setRawMode?.(true);
  } catch {
    // No raw mode available (a pty that refuses, a strange host). Better to
    // run without the panel's keys than to take input the tty still echoes.
    return { enabled: false, setHandler: () => {}, stop: () => {} };
  }
  input.resume();
  input.setEncoding("utf8");
  input.on("data", onData);
  process.on("exit", restore);

  return {
    get enabled() {
      return !stopped;
    },
    setHandler(next) {
      handler = next;
    },
    stop: restore,
  };
}

/**
 * Split a chunk into keys, keeping escape sequences whole.
 *
 * An arrow key is three bytes (`ESC [ A`) delivered in one chunk, and treating
 * them as three keys makes Up look like a literal `[` followed by an `A` —
 * which, in a panel where `a` means something, is a keystroke that does the
 * wrong thing rather than nothing.
 */
export function splitKeys(text: string): string[] {
  const keys: string[] = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] === "\x1b") {
      // CSI (`ESC [ … final`) and SS3 (`ESC O x`) cover the arrows, Home/End
      // and the function keys as any terminal in use sends them.
      const match = /^\x1b(\[[0-9;?]*[ -/]*[@-~]|O[A-Za-z]|.)/.exec(
        text.slice(i),
      );
      const seq = match?.[0] ?? "\x1b";
      keys.push(seq);
      i += seq.length;
      continue;
    }
    // Iterate by code point, so an emoji or a CJK character is one key rather
    // than two surrogate halves neither of which matches anything.
    const cp = text.codePointAt(i)!;
    const ch = String.fromCodePoint(cp);
    keys.push(ch);
    i += ch.length;
  }
  return keys;
}

/** Names for the sequences the panel binds, so its switch reads as English. */
export const KEY = {
  up: "\x1b[A",
  down: "\x1b[B",
  right: "\x1b[C",
  left: "\x1b[D",
  enter: "\r",
  escape: "\x1b",
} as const;
