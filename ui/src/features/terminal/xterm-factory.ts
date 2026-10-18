import { isPaletteKey } from "@/features/palette/palette-key";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal as XTerm } from "@xterm/xterm";

import { refreshWhenFontLoads, terminalFontFamily } from "./terminal-font";
import { brightenDimText } from "./terminal-dim";
import { isFontZoomKey } from "./font-zoom-key";
import { isDictationKey } from "@/features/dictation/dictation-key";

import { getTerminalTheme, terminalThemeToXterm, type ColorScheme } from "./terminal-themes";

/**
 * Construct an xterm instance the way this app needs one.
 *
 * The WebGL addon is deliberately **not** here. It is loaded asynchronously
 * with its own context-loss handling and per-view lifetime, and folding that
 * into a constructor would have made this function the thing it exists to
 * avoid — a shared helper that each caller has to work around.
 */

export type XtermBundle = {
  terminal: XTerm;
  fitAddon: FitAddon;
  searchAddon: SearchAddon;
};

export type XtermOptions = {
  container: HTMLElement;
  themeName: string;
  /** The app's resolved scheme, for the theme that matches it. */
  scheme: ColorScheme;
  fontSize: number;
  fontFamily: string;
  fontWeight: number;
  cursorStyle?: "block" | "underline" | "bar";
  cursorBlink?: boolean;
  scrollback?: number;
  /** Playback has nothing to type into. */
  disableStdin?: boolean;
  cols?: number;
  rows?: number;
};

/**
 * Make xterm's `RenderService.dimensions` getter null-safe.
 *
 * xterm.js 5.5.0 reads `this._renderer.value!.dimensions` behind a non-null
 * assertion, but `_renderer.value` *can* be undefined: while the WebGL addon is
 * replacing the canvas renderer, the Viewport's deferred
 * `setTimeout(() => syncScrollArea())` can fire mid-swap. The result is
 * "Cannot read properties of undefined (reading 'dimensions')" out of
 * RenderService.ts:50 / Viewport.ts:84.
 *
 * Returning the last known-good dimensions rather than zeros matters: FitAddon
 * divides by the cell size, and a zero there turns a transient render glitch
 * into a permanently mis-sized terminal.
 */
function patchRenderServiceDimensions(terminal: XTerm): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const core = (terminal as any)._core;
  if (!core?._renderService) return;

  const rs = core._renderService;
  const proto = Object.getPrototypeOf(rs);
  const desc = Object.getOwnPropertyDescriptor(proto, "dimensions");
  if (!desc?.get) return;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let lastValidDimensions: any = null;
  Object.defineProperty(rs, "dimensions", {
    get() {
      if (this._renderer?.value) {
        lastValidDimensions = this._renderer.value.dimensions;
        return lastValidDimensions;
      }
      if (lastValidDimensions) return lastValidDimensions;
      return {
        css: {
          canvas: { width: 0, height: 0 },
          cell: { width: 0, height: 0 },
        },
        device: {
          canvas: { width: 0, height: 0 },
          cell: { width: 0, height: 0 },
          char: { width: 0, height: 0, top: 0, left: 0 },
        },
      };
    },
    configurable: true,
  });
}

export function createXterm(options: XtermOptions): XtermBundle {
  const theme = getTerminalTheme(options.themeName, options.scheme);

  /*
   * An absent option is omitted, never passed as `undefined`.
   *
   * xterm does not fall back to its default for a key that is present with an
   * undefined value — it stores it. `scrollback` is then used as
   * `rows + scrollback`, which is `NaN`, and the buffer's `new Array(NaN)`
   * throws `RangeError: Invalid array length` from inside the `Terminal`
   * constructor. The live terminal never hit this because it always passes a
   * real number; the player, which wants xterm's own default, did.
   */
  const terminal = new XTerm({
    fontSize: options.fontSize,
    fontFamily: terminalFontFamily(options.fontFamily),
    // Same metrics on every device. Weight comes from the Terminal font weight
    // setting.
    // Bold is the variable face's heaviest instance. 1.15 keeps descenders
    // off the next row.
    fontWeight: options.fontWeight,
    fontWeightBold: 700,
    lineHeight: 1.15,
    minimumContrastRatio: 4.5,
    theme: terminalThemeToXterm(theme),
    allowProposedApi: true,
    macOptionIsMeta: true,
    ...(options.cursorStyle ? { cursorStyle: options.cursorStyle } : {}),
    ...(options.cursorBlink !== undefined ? { cursorBlink: options.cursorBlink } : {}),
    ...(options.scrollback !== undefined ? { scrollback: options.scrollback } : {}),
    ...(options.disableStdin ? { disableStdin: true } : {}),
    ...(options.cols ? { cols: options.cols } : {}),
    ...(options.rows ? { rows: options.rows } : {}),
    // A tmux PTY already emits CRLF. Rewriting bare \n corrupts the output of
    // applications that emit a lone linefeed deliberately.
    convertEol: false,
  });

  const fitAddon = new FitAddon();
  const searchAddon = new SearchAddon();
  const unicode11Addon = new Unicode11Addon();
  const webLinksAddon = new WebLinksAddon();

  terminal.loadAddon(fitAddon);
  terminal.loadAddon(searchAddon);
  terminal.loadAddon(unicode11Addon);
  terminal.loadAddon(webLinksAddon);

  // Font size keys belong to the app, not the shell. Without this, a focused
  // terminal turns Ctrl+- into a control character. Skipped here, the key
  // bubbles to the terminal layout, which sizes the terminal or the code view.
  terminal.attachCustomKeyEventHandler(
    (event) => !isFontZoomKey(event) && !isDictationKey(event) && !isPaletteKey(event),
  );

  terminal.unicode.activeVersion = "11";
  terminal.open(options.container);
  brightenDimText(terminal);
  if (terminal.textarea) {
    terminal.textarea.enterKeyHint = "enter";
    terminal.textarea.setAttribute("aria-label", "Terminal input");
    // Prevent Safari focus zoom without changing terminal character metrics.
    terminal.textarea.style.fontSize = "16px";
  }

  patchRenderServiceDimensions(terminal);
  void refreshWhenFontLoads(terminal, document.fonts, () => {
    // xterm 5 does not remeasure characters after web fonts finish loading.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (terminal as any)._core?._charSizeService?.measure();
    fitAddon.fit();
  });

  return { terminal, fitAddon, searchAddon };
}
