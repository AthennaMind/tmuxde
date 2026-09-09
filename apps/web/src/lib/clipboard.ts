/**
 * Copy text, including on the origin most mtmux users are actually on.
 *
 * `navigator.clipboard` exists only in a secure context, and `mtmux start`
 * serves the app over plain http on the LAN (`apps/cli/src/serve.ts`) — so on
 * the self-hosted path, which is the product's primary path, the whole API is
 * `undefined`. Every call site reached for it directly and reported the failure
 * as "Clipboard access denied", which is both wrong and unactionable: nothing
 * was denied, the API was never there.
 *
 * The fallback is `document.execCommand("copy")`. It is deprecated, and it is
 * also the only thing that works on a non-secure origin in every browser that
 * ships today. Using it is the difference between copy working and copy not
 * working for anyone who has not gone through the tunnel.
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
