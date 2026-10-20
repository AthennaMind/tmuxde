import { currentPlatform, type Platform } from "./platform";

/**
 * One key with its modifiers, as written in a keybindings file.
 *
 * `mod` from the file is already resolved here: cmd on Mac, ctrl elsewhere.
 * A chord never stores it, so two chords compare by their fields alone.
 */
export interface Chord {
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  cmd: boolean;
  /** Key name from the grammar, such as `k`, `0`, `f5`, `space` or `/`. */
  key: string;
}

export type ChordResult = { ok: true; chord: Chord } | { ok: false; error: string };

type Modifier = "ctrl" | "shift" | "alt" | "cmd" | "mod";

const MODIFIERS: Record<string, Modifier> = {
  ctrl: "ctrl",
  shift: "shift",
  alt: "alt",
  cmd: "cmd",
  meta: "cmd",
  super: "cmd",
  win: "cmd",
  mod: "mod",
};

const NAMED_KEYS = new Set([
  "enter",
  "escape",
  "space",
  "tab",
  "backspace",
  "delete",
  "up",
  "down",
  "left",
  "right",
  "home",
  "end",
  "pageup",
  "pagedown",
]);

const PUNCTUATION = new Set(["-", "=", "[", "]", "`", "/", "\\", ",", ".", ";", "'"]);

const FUNCTION_KEY = /^f([1-9]|1[0-2])$/;

export const MAX_CHORD_LENGTH = 64;

function isKeyName(name: string): boolean {
  return (
    /^[a-z0-9]$/.test(name) ||
    FUNCTION_KEY.test(name) ||
    NAMED_KEYS.has(name) ||
    PUNCTUATION.has(name)
  );
}

function fail(error: string): ChordResult {
  return { ok: false, error };
}

/**
 * Read one chord such as `ctrl+shift+k`.
 *
 * Lower case, `+` between parts, modifiers first and one key last. Spaces are
 * rejected so key sequences can use them later. `mod` becomes cmd on Mac and
 * ctrl elsewhere, so the platform decides the result. Each token appears
 * once, the rule the hub applies. Two names for one modifier, such as
 * `cmd+meta` or `mod+ctrl`, count once.
 */
export function parseChord(text: string, platform: Platform = currentPlatform()): ChordResult {
  if (!text) return fail("Chord is empty");
  if (text.length > MAX_CHORD_LENGTH)
    return fail(`Chord is longer than ${MAX_CHORD_LENGTH} characters`);
  if (/\s/.test(text)) return fail("Spaces are not allowed. Write one chord such as ctrl+shift+k");
  if (text !== text.toLowerCase()) return fail("Use lower case");

  const parts = text.split("+");
  const key = parts.pop() ?? "";
  const tokens = new Set<string>();
  const seen = new Set<Modifier>();
  for (const part of parts) {
    if (!part) return fail("Empty part between +");
    const modifier = MODIFIERS[part];
    if (!modifier) {
      return fail(
        isKeyName(part)
          ? `Only one key per chord, ${part} is not a modifier`
          : `Unknown modifier ${part}`,
      );
    }
    if (tokens.has(part)) return fail(`Modifier ${part} is repeated`);
    tokens.add(part);
    seen.add(modifier);
  }
  if (!key) return fail("Missing key after the last +");
  if (MODIFIERS[key]) return fail(`Missing key, ${key} is a modifier`);
  if (!isKeyName(key)) return fail(`Unknown key ${key}`);

  const mod = seen.has("mod");
  return {
    ok: true,
    chord: {
      ctrl: seen.has("ctrl") || (mod && platform !== "mac"),
      shift: seen.has("shift"),
      alt: seen.has("alt"),
      cmd: seen.has("cmd") || (mod && platform === "mac"),
      key,
    },
  };
}

/** Canonical text for maps: modifiers in a fixed order, then the key. */
export function chordKey(chord: Chord): string {
  const parts: string[] = [];
  if (chord.ctrl) parts.push("ctrl");
  if (chord.shift) parts.push("shift");
  if (chord.alt) parts.push("alt");
  if (chord.cmd) parts.push("cmd");
  parts.push(chord.key);
  return parts.join("+");
}

/** A chord with ctrl, alt or cmd. Without one it is typing in a text field. */
export function hasCommandModifier(chord: Chord): boolean {
  return chord.ctrl || chord.alt || chord.cmd;
}

const KEY_LABELS: Record<string, [mac: string, other: string]> = {
  enter: ["↵", "Enter"],
  escape: ["Esc", "Esc"],
  space: ["Space", "Space"],
  tab: ["⇥", "Tab"],
  backspace: ["⌫", "Backspace"],
  delete: ["⌦", "Delete"],
  up: ["↑", "↑"],
  down: ["↓", "↓"],
  left: ["←", "←"],
  right: ["→", "→"],
  home: ["Home", "Home"],
  end: ["End", "End"],
  pageup: ["PgUp", "PgUp"],
  pagedown: ["PgDn", "PgDn"],
};

function keyLabel(key: string, platform: Platform): string {
  const label = KEY_LABELS[key];
  if (label) return platform === "mac" ? label[0] : label[1];
  return key.toUpperCase();
}

/**
 * The chord as the user sees it. Mac uses the modifier symbols in Apple's
 * order, such as `⇧⌘F`. Elsewhere words joined by spaces, such as `Ctrl Shift F`.
 */
export function formatChord(chord: Chord, platform: Platform): string {
  const key = keyLabel(chord.key, platform);
  if (platform === "mac") {
    const symbols = [chord.ctrl && "⌃", chord.alt && "⌥", chord.shift && "⇧", chord.cmd && "⌘"];
    return `${symbols.filter(Boolean).join("")}${key}`;
  }
  const parts: string[] = [];
  if (chord.ctrl) parts.push("Ctrl");
  if (chord.shift) parts.push("Shift");
  if (chord.alt) parts.push("Alt");
  if (chord.cmd) parts.push("Meta");
  parts.push(key);
  return parts.join(" ");
}

export type ChordEvent = Pick<
  KeyboardEvent,
  "key" | "code" | "ctrlKey" | "shiftKey" | "altKey" | "metaKey"
>;

/** `event.key` values of keys that only modify another key. */
const MODIFIER_VALUES = new Set([
  "Control",
  "Shift",
  "Alt",
  "AltGraph",
  "Meta",
  "OS",
  "Super",
  "Hyper",
  "Fn",
  "FnLock",
  "CapsLock",
  "NumLock",
  "ScrollLock",
  "Symbol",
  "SymbolLock",
]);

const EVENT_KEYS: Record<string, string> = {
  Enter: "enter",
  Escape: "escape",
  Esc: "escape",
  " ": "space",
  Spacebar: "space",
  Tab: "tab",
  Backspace: "backspace",
  Delete: "delete",
  Del: "delete",
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
  Up: "up",
  Down: "down",
  Left: "left",
  Right: "right",
  Home: "home",
  End: "end",
  PageUp: "pageup",
  PageDown: "pagedown",
};

/**
 * Shifted symbols of a US layout and the key they sit on.
 *
 * `?` is Shift with `/`, so it reads as `shift+/`. A layout that types `+`
 * without Shift still reads as `shift+=`, which keeps zoom keys working there.
 */
const SHIFTED: Record<string, string> = {
  "?": "/",
  "+": "=",
  _: "-",
  "{": "[",
  "}": "]",
  "~": "`",
  "|": "\\",
  "<": ",",
  ">": ".",
  ":": ";",
  '"': "'",
};

/** Punctuation by `event.code`. Option on a Mac turns `[` into `“` in `event.key`. */
const PUNCTUATION_CODES: Record<string, string> = {
  Minus: "-",
  Equal: "=",
  BracketLeft: "[",
  BracketRight: "]",
  Backquote: "`",
  Slash: "/",
  Backslash: "\\",
  Comma: ",",
  Period: ".",
  Semicolon: ";",
  Quote: "'",
};

/**
 * The chord a key press makes, or null for a bare modifier or an unknown key.
 *
 * Letters and digits come from `event.code`, so Shift and Alt do not change
 * their name. Everything else comes from `event.key`, with `event.code` for
 * punctuation that Alt changed into another character. Non Latin layouts are
 * a known limit.
 */
export function chordFromEvent(event: ChordEvent): Chord | null {
  // Autofill and some virtual keyboards send keydown without a key. Process
  // is an input method at work.
  if (typeof event.key !== "string" || event.key === "Process") return null;
  if (MODIFIER_VALUES.has(event.key)) return null;
  let shift = event.shiftKey;
  let key: string | null = null;
  const code = typeof event.code === "string" ? event.code : "";
  const letterOrDigit = /^(?:Key([A-Z])|Digit([0-9]))$/.exec(code);
  if (letterOrDigit) {
    key = (letterOrDigit[1] ?? letterOrDigit[2] ?? "").toLowerCase();
  } else if (EVENT_KEYS[event.key]) {
    key = EVENT_KEYS[event.key] ?? null;
  } else if (/^F([1-9]|1[0-2])$/.test(event.key)) {
    key = event.key.toLowerCase();
  } else if (event.key.length === 1) {
    const lower = event.key.toLowerCase();
    if (/^[a-z0-9]$/.test(lower) || PUNCTUATION.has(lower)) key = lower;
    else if (SHIFTED[event.key]) {
      key = SHIFTED[event.key] ?? null;
      shift = true;
    }
  }
  if (!key && event.altKey) key = PUNCTUATION_CODES[code] ?? null;
  if (!key) return null;
  return { ctrl: event.ctrlKey, shift, alt: event.altKey, cmd: event.metaKey, key };
}
