/**
 * Text handling for dictation: what may reach a terminal, how pieces join and
 * how text goes into a field React owns.
 */

// oxlint-disable-next-line no-control-regex -- matches C0 and C1 controls on purpose.
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;

/**
 * Drop everything a terminal would read as a command.
 *
 * The speech service only ever returns words, but its output still ends up
 * in a pty, and an ESC in there is a key press. C0 and C1 controls go, and
 * line breaks become spaces: a newline in a shell prompt runs the line.
 */
export function sanitizeDictation(text: string): string {
  return text
    .replace(/[\r\n\t]+/g, " ")
    .replace(CONTROL_CHARS, "")
    .replace(/ {2,}/g, " ")
    .trim();
}

// Adapted from Orca `dictation-final-segments.ts`.
// MIT License, Copyright (c) 2026 Lovecast Inc.
const WORD_CHAR = /^[\p{L}\p{N}]$/u;
const CJK_CHAR = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]$/u;
const NO_SPACE_BEFORE = /^[,.;:!?%。，、！？；：）)\]}]$/u;
const NO_SPACE_AFTER = /^[([{（《「『]$/u;
const SPACE_AFTER = /^[,.;:!?%]$/u;

/**
 * The next piece as it should be typed after `before`.
 *
 * Text arrives in pieces cut at pauses, so "fix the bug" and "in the relay"
 * need a space between them. Not before punctuation, not after an opening
 * bracket, not between CJK characters, and never doubled.
 */
export function joinSegment(before: string, next: string): string {
  if (!before || !next || /\s$/.test(before) || /^\s/.test(next)) return next;
  const last = Array.from(before.trimEnd()).at(-1) ?? "";
  const first = Array.from(next.trimStart())[0] ?? "";
  if (!last || !first) return next;
  if (
    CJK_CHAR.test(last) ||
    CJK_CHAR.test(first) ||
    NO_SPACE_BEFORE.test(first) ||
    NO_SPACE_AFTER.test(last)
  ) {
    return next;
  }
  const space = (WORD_CHAR.test(last) || SPACE_AFTER.test(last)) && WORD_CHAR.test(first);
  return space ? ` ${next}` : next;
}

export type TextField = HTMLTextAreaElement | HTMLInputElement;

const TEXT_INPUT_TYPES = new Set(["text", "search", "url", "email", ""]);

/**
 * A field dictation can type into: an editable textarea or text input.
 *
 * xterm's helper textarea is excluded. Typing there would bypass xterm,
 * and the terminal has its own way in.
 */
export function isTextField(el: Element | null): el is TextField {
  if (!el || el.classList.contains("xterm-helper-textarea")) return false;
  const editable =
    el.tagName === "TEXTAREA" ||
    (el.tagName === "INPUT" && TEXT_INPUT_TYPES.has((el as HTMLInputElement).type));
  if (!editable) return false;
  const field = el as TextField;
  return !field.readOnly && !field.disabled;
}

/** Text before the caret, for deciding whether the next piece needs a space. */
export function textBeforeCaret(field: TextField): string {
  return field.value.slice(0, field.selectionStart ?? field.value.length);
}

/**
 * Insert at the caret the way typing would.
 *
 * `setRangeText` changes the value without going through the `value` setter
 * React watches, so the `input` event that follows reads as a real change and
 * the component's state picks it up. Assigning `value` directly would be
 * swallowed as a no-op.
 */
export function insertIntoField(field: TextField, text: string): void {
  const start = field.selectionStart ?? field.value.length;
  const end = field.selectionEnd ?? start;
  field.setRangeText(text, start, end, "end");
  field.dispatchEvent(new Event("input", { bubbles: true }));
}
