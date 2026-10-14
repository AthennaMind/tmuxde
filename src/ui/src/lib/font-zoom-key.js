// @ts-check

/** @type {Map<string, -1 | 0 | 1>} */
const ZOOM_KEYS = new Map([
  ["-", -1],
  ["=", 1],
  ["+", 1],
  ["0", 0],
]);

/**
 * Ctrl or Cmd with -, =, + or 0: the app's font size keys.
 *
 * Returns the step, 1 larger, -1 smaller, 0 reset, or null for any other key.
 * Shift is allowed because Ctrl++ is Ctrl+Shift+= on most layouts. Ctrl+_
 * is not a zoom key, so readline undo still reaches the shell.
 *
 * @param {Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey">} event
 * @returns {-1 | 0 | 1 | null}
 */
export function fontZoomStep(event) {
  if (!(event.ctrlKey || event.metaKey) || event.altKey) return null;
  return ZOOM_KEYS.get(event.key) ?? null;
}

/** @param {Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey">} event */
export function isFontZoomKey(event) {
  return fontZoomStep(event) !== null;
}
