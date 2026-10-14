export interface TerminalTheme {
  name: string;
  foreground: string;
  background: string;
  cursor: string;
  cursorAccent: string;
  selectionBackground: string;
  selectionForeground?: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

export type ColorScheme = "light" | "dark";

/**
 * Not a palette. Picks `tmuxdeDark` or `tmuxdeLight` to match the app's
 * light or dark scheme, the way "System" follows the device.
 */
export const DEFAULT_TERMINAL_THEME = "tmuxde";

/*
 * The tmuxde palettes are the app's own tokens, so the terminal reads as part
 * of the IDE. Values are tokens in `globals.css` converted to hex, because
 * xterm parses hex directly and oklch only through a canvas fallback.
 * `theme-contrast.test.ts` checks each one against its token, so a token
 * change fails there instead of drifting here.
 *
 * Both map the same role to the same token: text, signals, brand cursor and
 * the app's ::selection. The app has no blue, and only one step per signal
 * hue, so blue and the bright colours are terminal only. Each keeps its base
 * hue and holds chroma inside sRGB. Bright steps away from the background:
 * lighter in dark, darker in light, the same way `--brand-hover` moves.
 * Every text colour passes 4.5:1, so xterm's `minimumContrastRatio` never
 * shifts one.
 */
export const terminalThemes: Record<string, TerminalTheme> = {
  /**
   * The colour nearest the background is black, raised like a border. Black
   * text on any colour fill, as in tmux's status line and copy mode, passes.
   */
  tmuxdeDark: {
    name: "tmuxde Dark",
    foreground: "#eae7de", // --text
    background: "#0a0b0a", // --surface-base
    cursor: "#a6e96b", // --brand
    cursorAccent: "#0a0b0a", // --brand-contrast
    selectionBackground: "#a6e96b", // --brand
    selectionForeground: "#0a0b0a", // --brand-contrast
    black: "#23281f", // --line
    red: "#f07171", // --signal-failed
    green: "#a6e96b", // --signal-done
    yellow: "#f0b65c", // --signal-blocked
    blue: "#6db3fa", // oklch(0.75 0.125 250)
    magenta: "#b79ceb", // --signal-agent
    cyan: "#7ccfd9", // --signal-stalled
    white: "#eae7de", // --text
    brightBlack: "#9aa18c", // --text-subtle
    brightRed: "#fc9794", // oklch(0.78 0.122 21.96)
    brightGreen: "#bcf287", // --brand-hover
    brightYellow: "#fdd083", // oklch(0.88 0.108 80)
    brightBlue: "#9eccfc", // oklch(0.83 0.084 250)
    brightMagenta: "#d0bafc", // oklch(0.83 0.094 299.32)
    brightCyan: "#a0e5ee", // oklch(0.88 0.07 205.56)
    brightWhite: "#f4f2ec", // --text-strong
  },
  /**
   * The mirror: white is the raised surface and black is body text. White
   * text on any colour fill passes, for badges written for dark terminals.
   */
  tmuxdeLight: {
    name: "tmuxde Light",
    foreground: "#2b2f2a", // --text
    background: "#fafcfa", // --surface-base
    cursor: "#437200", // --brand
    cursorAccent: "#f6f9f6", // --brand-contrast
    selectionBackground: "#437200", // --brand
    selectionForeground: "#f6f9f6", // --brand-contrast
    black: "#2b2f2a", // --text
    red: "#be1219", // --signal-failed
    green: "#067132", // --signal-done
    yellow: "#865901", // --signal-blocked
    blue: "#0c62b7", // oklch(0.5 0.153 254)
    magenta: "#7148b0", // --signal-agent
    cyan: "#02717a", // --signal-stalled
    white: "#e2e6e1", // --line-subtle
    brightBlack: "#656b63", // --text-subtle
    brightRed: "#970d12", // oklch(0.43 0.168 27)
    brightGreen: "#075a28", // oklch(0.41 0.109 150)
    brightYellow: "#6c4806", // oklch(0.43 0.088 75)
    brightBlue: "#074f95", // oklch(0.43 0.132 254)
    brightMagenta: "#5d3595", // oklch(0.43 0.15 299)
    brightCyan: "#085b62", // oklch(0.43 0.071 205)
    brightWhite: "#ffffff", // --surface-raised
  },
  dracula: {
    name: "Dracula",
    foreground: "#f8f8f2",
    background: "#282a36",
    cursor: "#f8f8f2",
    cursorAccent: "#282a36",
    selectionBackground: "#44475a",
    black: "#21222c",
    red: "#ff5555",
    green: "#50fa7b",
    yellow: "#f1fa8c",
    blue: "#bd93f9",
    magenta: "#ff79c6",
    cyan: "#8be9fd",
    white: "#f8f8f2",
    brightBlack: "#6272a4",
    brightRed: "#ff6e6e",
    brightGreen: "#69ff94",
    brightYellow: "#ffffa5",
    brightBlue: "#d6acff",
    brightMagenta: "#ff92df",
    brightCyan: "#a4ffff",
    brightWhite: "#ffffff",
  },
  solarizedDark: {
    name: "Solarized Dark",
    foreground: "#839496",
    background: "#002b36",
    cursor: "#839496",
    cursorAccent: "#002b36",
    selectionBackground: "#073642",
    black: "#073642",
    red: "#dc322f",
    green: "#859900",
    yellow: "#b58900",
    blue: "#268bd2",
    magenta: "#d33682",
    cyan: "#2aa198",
    white: "#eee8d5",
    brightBlack: "#586e75",
    brightRed: "#cb4b16",
    brightGreen: "#586e75",
    brightYellow: "#657b83",
    brightBlue: "#839496",
    brightMagenta: "#6c71c4",
    brightCyan: "#93a1a1",
    brightWhite: "#fdf6e3",
  },
  oneDark: {
    name: "One Dark",
    foreground: "#abb2bf",
    background: "#282c34",
    cursor: "#528bff",
    cursorAccent: "#282c34",
    selectionBackground: "#3e4451",
    black: "#282c34",
    red: "#e06c75",
    green: "#98c379",
    yellow: "#e5c07b",
    blue: "#61afef",
    magenta: "#c678dd",
    cyan: "#56b6c2",
    white: "#abb2bf",
    brightBlack: "#5c6370",
    brightRed: "#e06c75",
    brightGreen: "#98c379",
    brightYellow: "#e5c07b",
    brightBlue: "#61afef",
    brightMagenta: "#c678dd",
    brightCyan: "#56b6c2",
    brightWhite: "#ffffff",
  },
  tokyoNight: {
    name: "Tokyo Night",
    foreground: "#a9b1d6",
    background: "#1a1b26",
    cursor: "#c0caf5",
    cursorAccent: "#1a1b26",
    selectionBackground: "#33467c",
    black: "#15161e",
    red: "#f7768e",
    green: "#9ece6a",
    yellow: "#e0af68",
    blue: "#7aa2f7",
    magenta: "#bb9af7",
    cyan: "#7dcfff",
    white: "#a9b1d6",
    brightBlack: "#414868",
    brightRed: "#f7768e",
    brightGreen: "#9ece6a",
    brightYellow: "#e0af68",
    brightBlue: "#7aa2f7",
    brightMagenta: "#bb9af7",
    brightCyan: "#7dcfff",
    brightWhite: "#c0caf5",
  },
  catppuccin: {
    name: "Catppuccin Mocha",
    foreground: "#cdd6f4",
    background: "#1e1e2e",
    cursor: "#f5e0dc",
    cursorAccent: "#1e1e2e",
    selectionBackground: "#45475a",
    black: "#45475a",
    red: "#f38ba8",
    green: "#a6e3a1",
    yellow: "#f9e2af",
    blue: "#89b4fa",
    magenta: "#f5c2e7",
    cyan: "#94e2d5",
    white: "#bac2de",
    brightBlack: "#585b70",
    brightRed: "#f38ba8",
    brightGreen: "#a6e3a1",
    brightYellow: "#f9e2af",
    brightBlue: "#89b4fa",
    brightMagenta: "#f5c2e7",
    brightCyan: "#94e2d5",
    brightWhite: "#a6adc8",
  },
  nord: {
    name: "Nord",
    foreground: "#d8dee9",
    background: "#2e3440",
    cursor: "#d8dee9",
    cursorAccent: "#2e3440",
    selectionBackground: "#434c5e",
    black: "#3b4252",
    red: "#bf616a",
    green: "#a3be8c",
    yellow: "#ebcb8b",
    blue: "#81a1c1",
    magenta: "#b48ead",
    cyan: "#88c0d0",
    white: "#e5e9f0",
    brightBlack: "#4c566a",
    brightRed: "#bf616a",
    brightGreen: "#a3be8c",
    brightYellow: "#ebcb8b",
    brightBlue: "#81a1c1",
    brightMagenta: "#b48ead",
    brightCyan: "#8fbcbb",
    brightWhite: "#eceff4",
  },
  gruvbox: {
    name: "Gruvbox Dark",
    foreground: "#ebdbb2",
    background: "#282828",
    cursor: "#ebdbb2",
    cursorAccent: "#282828",
    selectionBackground: "#504945",
    black: "#282828",
    red: "#cc241d",
    green: "#98971a",
    yellow: "#d79921",
    blue: "#458588",
    magenta: "#b16286",
    cyan: "#689d6a",
    white: "#a89984",
    brightBlack: "#928374",
    brightRed: "#fb4934",
    brightGreen: "#b8bb26",
    brightYellow: "#fabd2f",
    brightBlue: "#83a598",
    brightMagenta: "#d3869b",
    brightCyan: "#8ec07c",
    brightWhite: "#ebdbb2",
  },
  monokai: {
    name: "Monokai",
    foreground: "#f8f8f2",
    background: "#272822",
    cursor: "#f8f8f0",
    cursorAccent: "#272822",
    selectionBackground: "#49483e",
    black: "#272822",
    red: "#f92672",
    green: "#a6e22e",
    yellow: "#f4bf75",
    blue: "#66d9ef",
    magenta: "#ae81ff",
    cyan: "#a1efe4",
    white: "#f8f8f2",
    brightBlack: "#75715e",
    brightRed: "#f92672",
    brightGreen: "#a6e22e",
    brightYellow: "#f4bf75",
    brightBlue: "#66d9ef",
    brightMagenta: "#ae81ff",
    brightCyan: "#a1efe4",
    brightWhite: "#f9f8f5",
  },
};

/** The palette to draw with. `scheme` is the app's resolved light or dark. */
export function getTerminalTheme(
  name: string,
  scheme: ColorScheme,
): TerminalTheme {
  const matched =
    scheme === "light" ? terminalThemes.tmuxdeLight! : terminalThemes.tmuxdeDark!;
  if (name === DEFAULT_TERMINAL_THEME) return matched;
  return terminalThemes[name] ?? matched;
}

export function terminalThemeToXterm(theme: TerminalTheme) {
  return {
    foreground: theme.foreground,
    background: theme.background,
    cursor: theme.cursor,
    cursorAccent: theme.cursorAccent,
    selectionBackground: theme.selectionBackground,
    selectionForeground: theme.selectionForeground,
    black: theme.black,
    red: theme.red,
    green: theme.green,
    yellow: theme.yellow,
    blue: theme.blue,
    magenta: theme.magenta,
    cyan: theme.cyan,
    white: theme.white,
    brightBlack: theme.brightBlack,
    brightRed: theme.brightRed,
    brightGreen: theme.brightGreen,
    brightYellow: theme.brightYellow,
    brightBlue: theme.brightBlue,
    brightMagenta: theme.brightMagenta,
    brightCyan: theme.brightCyan,
    brightWhite: theme.brightWhite,
  };
}
