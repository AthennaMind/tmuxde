type XtermRenderer = {
  _injectCss?: (...args: unknown[]) => void;
  _themeStyleElement?: { textContent: string | null };
};

type XtermInternals = {
  _core?: { _renderService?: { _renderer?: { value?: XtermRenderer } } };
};

/**
 * xterm 5.5's DOM renderer halves opacity for dim default and ANSI colors.
 * Raise that to 80%. Keep RGB channels, inline contrast corrections,
 * and terminal buffer attributes intact. Truecolor spans already stay opaque.
 *
 * This private hook is isolated because xterm has no dim-opacity option.
 * Recheck _injectCss and its eight-digit colors when upgrading xterm.
 * Renderer owns this wrapper. No observer or external listener needs cleanup.
 */
export function brightenDimText(terminal: unknown) {
  const core = terminal as XtermInternals;
  const renderer = core?._core?._renderService?._renderer?.value;
  const injectCss = renderer?._injectCss;
  if (!renderer?._themeStyleElement || typeof injectCss !== "function") return;

  const brightenStyles = () => {
    const style = renderer._themeStyleElement;
    if (!style?.textContent) return;
    style.textContent = style.textContent.replace(
      /(\.xterm-dim\s*\{\s*color:\s*#[\da-f]{6})80(?=\s*;)/gi,
      "$1cc",
    );
  };

  renderer._injectCss = function (this: unknown, ...args: unknown[]) {
    injectCss.apply(this, args);
    brightenStyles();
  };
  brightenStyles();
}
