/**
 * Ctrl+Shift+Space starts and stops dictation, on every platform.
 *
 * Chosen because nothing in a terminal wants it: Ctrl+Space is readline's
 * set-mark and an input method switch on some systems, but adding Shift
 * leaves no common binding behind. xterm is told to skip it so it reaches the
 * window listener instead of becoming a NUL byte in the shell.
 */
export function isDictationKey(
  event: Pick<KeyboardEvent, "key" | "code" | "ctrlKey" | "shiftKey" | "altKey" | "metaKey">,
): boolean {
  return (
    event.ctrlKey &&
    event.shiftKey &&
    !event.altKey &&
    !event.metaKey &&
    (event.code === "Space" || event.key === " ")
  );
}
