// @ts-check

const ZOOM_KEYS = new Set(["-", "=", "+", "0"]);

/**
 * Ctrl or Cmd with -, =, + or 0: the browser's page zoom.
 *
 * Shift is allowed because Ctrl++ is Ctrl+Shift+= on most layouts. Ctrl+_
 * is not a zoom key, so readline undo still reaches the shell.
 *
 * @param {Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey">} event
 */
export function isBrowserZoomKey(event) {
  return (
    (event.ctrlKey || event.metaKey) &&
    !event.altKey &&
    ZOOM_KEYS.has(event.key)
  );
}
