// @ts-check

export const DEFAULT_TERMINAL_FONT = '"IBM Plex Mono", monospace';
const LEGACY_TERMINAL_FONT =
  "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace";

// This face contains only symbols. Text still uses the user's preferred font.
/** @param {string} preferred */
export function terminalFontFamily(preferred) {
  const textFont =
    preferred === LEGACY_TERMINAL_FONT ? DEFAULT_TERMINAL_FONT : preferred;
  return `"Symbols Nerd Font Mono", ${textFont}`;
}

/**
 * @param {Pick<import("@xterm/xterm").Terminal, "element" | "rows" | "clearTextureAtlas" | "refresh">} terminal
 * @param {Pick<FontFaceSet, "load">} fonts
 * @param {() => void} onReady
 */
export async function refreshWhenFontLoads(
  terminal,
  fonts = document.fonts,
  onReady = () => {},
) {
  try {
    const results = await Promise.allSettled([
      fonts.load('16px "Symbols Nerd Font Mono"', "\ue0b0"),
      fonts.load('400 16px "IBM Plex Mono"', "W"),
      fonts.load('500 16px "IBM Plex Mono"', "W"),
    ]);
    if (!results.some((result) => result.status === "fulfilled")) return;
    if (!terminal.element?.isConnected) return;
    onReady();
    // Renderers can cache missing glyphs before the font download finishes.
    terminal.clearTextureAtlas();
    terminal.refresh(0, terminal.rows - 1);
  } catch {
    // Keep the terminal usable if the font cannot load.
  }
}
