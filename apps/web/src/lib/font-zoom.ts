import { useFileStore } from "@/stores/file-store";
import {
  SETTINGS_TAB,
  TERMINAL_TAB,
  useMainTabsStore,
} from "@/stores/main-tabs-store";
import {
  CODE_ZOOM_STEP,
  clampFontSize,
  getDefaultFontSize,
  useTerminalStore,
} from "@/stores/terminal-store";
import { useUiStore } from "@/stores/ui-store";
import { isMobileViewport } from "@/lib/mobile-query";

/**
 * What Ctrl with -, = and 0 resizes: the code on screen, or the terminal.
 *
 * Code when a file or diff tab is in front, the editor overlay is open, or
 * the phone is on its Files tab. The terminal otherwise, settings included,
 * where the font size row shows the change.
 */
export function fontZoomTarget(): "code" | "terminal" {
  const active = useMainTabsStore.getState().active;
  if (active !== TERMINAL_TAB && active !== SETTINGS_TAB) return "code";
  if (useFileStore.getState().editorFile) return "code";
  if (isMobileViewport() && useUiStore.getState().mobileTab === "files")
    return "code";
  return "terminal";
}

/** Apply one step: 1 larger, -1 smaller, 0 back to default. */
export function applyFontZoom(step: -1 | 0 | 1): void {
  const store = useTerminalStore.getState();
  if (fontZoomTarget() === "code") {
    store.setCodeZoom(step === 0 ? 1 : store.codeZoom + step * CODE_ZOOM_STEP);
    return;
  }
  store.setFontSize(
    step === 0 ? getDefaultFontSize() : clampFontSize(store.fontSize + step),
  );
}
