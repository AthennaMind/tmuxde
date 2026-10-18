import {
  CODE_ZOOM_STEP,
  clampFontSize,
  getDefaultFontSize,
  useTerminalStore,
} from "@/stores/terminal-store";

export type ZoomSurface = "terminal" | "code";

/**
 * Marks the element a zoom key resizes: `terminal` for the terminal font size,
 * `code` for file, diff and editor text. Anywhere unmarked keeps browser zoom.
 */
export const ZOOM_SURFACE = "data-zoom-surface";

/** What a click last landed on, for keys pressed with nothing focused. */
let lastPointerTarget: Element | null = null;

function asElement(target: EventTarget | null): Element | null {
  return target && typeof (target as Element).closest === "function" ? (target as Element) : null;
}

export function notePointerTarget(target: EventTarget | null): void {
  lastPointerTarget = asElement(target);
}

/** Remember each pointer press. Returns the cleanup. */
export function trackZoomPointer(): () => void {
  const remember = (event: PointerEvent) => notePointerTarget(event.target);
  window.addEventListener("pointerdown", remember, true);
  return () => window.removeEventListener("pointerdown", remember, true);
}

/** The marked surface holding `element`, if it is still on screen. */
export function zoomSurfaceOf(element: Element | null): ZoomSurface | null {
  // A closed tab, or the terminal hidden behind one, no longer counts.
  if (!element?.isConnected || element.closest("[inert]")) return null;
  const surface = element.closest(`[${ZOOM_SURFACE}]`)?.getAttribute(ZOOM_SURFACE);
  return surface === "terminal" || surface === "code" ? surface : null;
}

/**
 * Where Ctrl with -, = or 0 lands. The focused element decides. Clicking text
 * that cannot take focus leaves focus on the page body, and then the last
 * click decides. Null hands the key back to the browser.
 */
export function fontZoomSurface(
  target: EventTarget | null,
  body: Element | null = document.body,
): ZoomSurface | null {
  const focused = asElement(target);
  if (focused && focused !== body) return zoomSurfaceOf(focused);
  return zoomSurfaceOf(lastPointerTarget);
}

/** Apply one step: 1 larger, -1 smaller, 0 back to default. */
export function applyFontZoom(surface: ZoomSurface, step: -1 | 0 | 1): void {
  const store = useTerminalStore.getState();
  if (surface === "code") {
    store.setCodeZoom(step === 0 ? 1 : store.codeZoom + step * CODE_ZOOM_STEP);
    return;
  }
  store.setFontSize(step === 0 ? getDefaultFontSize() : clampFontSize(store.fontSize + step));
}
