/** How long the Blob URL lives after the click. Some browsers read it late. */
const REVOKE_DELAY_MS = 10_000;

/**
 * Save text as a file through the browser's download.
 *
 * The text never leaves the page. A Blob URL points at it, a temporary
 * anchor with `download` starts the save, and the URL is revoked after a
 * pause, since Safari reads it after `click` returns.
 */
export function downloadText(fileName: string, text: string, type = "application/json"): void {
  const url = URL.createObjectURL(new Blob([text], { type: `${type};charset=utf-8` }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = "noopener";
  anchor.style.display = "none";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), REVOKE_DELAY_MS);
}
