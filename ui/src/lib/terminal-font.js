// @ts-check

export const DEFAULT_TERMINAL_FONT = '"Cascadia Code", "IBM Plex Mono", monospace';

/** Earlier defaults, stored by persisted settings. None was a user choice. */
const RETIRED_DEFAULTS = new Set([
  "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
  '"IBM Plex Mono", monospace',
]);

// This face contains only symbols. Text still uses the user's preferred font.
/** @param {string} preferred */
export function terminalFontFamily(preferred) {
  const textFont = RETIRED_DEFAULTS.has(preferred) ? DEFAULT_TERMINAL_FONT : preferred;
  return `"Symbols Nerd Font Mono", ${textFont}`;
}

/**
 * @param {Pick<import("@xterm/xterm").Terminal, "element" | "rows" | "clearTextureAtlas" | "refresh">} terminal
 * @param {Pick<FontFaceSet, "load">} fonts
 * @param {() => void} onReady
 */
export async function refreshWhenFontLoads(terminal, fonts = document.fonts, onReady = () => {}) {
  try {
    const results = await Promise.allSettled([
      fonts.load('16px "Symbols Nerd Font Mono"', "\ue0b0"),
      // One variable file serves every weight.
      fonts.load('400 16px "Cascadia Code"', "W"),
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
