const ZOOM_KEYS = new Map<string, -1 | 0 | 1>([
  ["-", -1],
  ["=", 1],
  ["+", 1],
  ["0", 0],
]);

type ZoomKeyEvent = Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey">;

/**
 * Ctrl or Cmd with -, =, + or 0: the app's font size keys.
 *
 * Returns the step, 1 larger, -1 smaller, 0 reset, or null for any other key.
 * Shift is allowed because Ctrl++ is Ctrl+Shift+= on most layouts. Ctrl+_
 * is not a zoom key, so readline undo still reaches the shell.
 */
export function fontZoomStep(event: ZoomKeyEvent): -1 | 0 | 1 | null {
  if (!(event.ctrlKey || event.metaKey) || event.altKey) return null;
  return ZOOM_KEYS.get(event.key) ?? null;
}

export function isFontZoomKey(event: ZoomKeyEvent) {
  return fontZoomStep(event) !== null;
}
