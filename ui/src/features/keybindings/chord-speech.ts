import type { Chord } from "./chord";
import type { Platform } from "./platform";

/**
 * Words for a chord, for screen readers.
 *
 * `formatChord` gives `⇧⌘F` on a Mac, which a screen reader reads as symbol
 * names or not at all. This gives `Shift Command F` instead. Pair it with the
 * visible label as visually hidden text.
 */

const KEY_WORDS: Record<string, string> = {
  enter: "Enter",
  escape: "Escape",
  space: "Space",
  tab: "Tab",
  backspace: "Backspace",
  delete: "Delete",
  up: "Up arrow",
  down: "Down arrow",
  left: "Left arrow",
  right: "Right arrow",
  home: "Home",
  end: "End",
  pageup: "Page up",
  pagedown: "Page down",
  "-": "Minus",
  "=": "Equals",
  "[": "Left bracket",
  "]": "Right bracket",
  "`": "Backtick",
  "/": "Slash",
  "\\": "Backslash",
  ",": "Comma",
  ".": "Period",
  ";": "Semicolon",
  "'": "Quote",
};

export function chordSpeech(chord: Chord, platform: Platform): string {
  const mac = platform === "mac";
  const words: string[] = [];
  if (chord.ctrl) words.push("Control");
  if (chord.alt) words.push(mac ? "Option" : "Alt");
  if (chord.shift) words.push("Shift");
  if (chord.cmd) words.push(mac ? "Command" : "Meta");
  words.push(KEY_WORDS[chord.key] ?? chord.key.toUpperCase());
  return words.join(" ");
}
