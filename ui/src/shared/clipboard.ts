/**
 * Copy text, including on an origin without the async clipboard API.
 *
 * `navigator.clipboard` exists only in a secure context. A page opened over
 * plain http, or in a browser that does not trust the local CA, has no such
 * API at all. Reporting that as "Clipboard access denied" would be wrong.
 * Nothing was denied. The API was never there.
 *
 * The fallback is `document.execCommand("copy")`. It is deprecated. It is
 * also the only thing that works on a non-secure origin in every browser that
 * ships today.
 */
export async function copyText(text: string): Promise<boolean> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Permission refused, or a document that lost focus mid-write. Fall
      // through — execCommand sometimes still succeeds where this did not.
    }
  }
  return legacyCopy(text);
}

/** Why a copy failed, in words a user can do something about. */
export function copyFailureReason(): string {
  if (typeof window !== "undefined" && !window.isSecureContext) {
    return "Copying needs a secure connection — open the invite link instead of the LAN address";
  }
  return "Couldn't copy to the clipboard";
}

function legacyCopy(text: string): boolean {
  if (typeof document === "undefined") return false;
  const area = document.createElement("textarea");
  area.value = text;
  // Off-screen rather than hidden: `display: none` and `visibility: hidden`
  // both make the selection unreachable, and the element must be focusable for
  // the copy to have anything to act on.
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.top = "-9999px";
  area.style.opacity = "0";
  // Stops iOS from scrolling to the element and zooming to its font size.
  area.style.fontSize = "16px";
  document.body.appendChild(area);
  const previous = document.activeElement;
  try {
    area.select();
    area.setSelectionRange(0, text.length);
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    area.remove();
    if (previous instanceof HTMLElement) previous.focus();
  }
}
