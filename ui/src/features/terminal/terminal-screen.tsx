import { useEffect, useMemo, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { useTheme } from "@/shared/use-theme";
import type { PreviewFrame } from "@/protocol";
import { terminalFontFamily, refreshWhenFontLoads } from "./terminal-font";
import { getTerminalTheme, terminalThemeToXterm } from "./terminal-themes";
import { useTerminalStore } from "./terminal-store";
import "@xterm/xterm/css/xterm.css";

/** A screen is fitted locally. Preview terminals never attach, resize or send input. */
export function TerminalScreen({
  frame,
  readable = false,
}: {
  frame: PreviewFrame;
  readable?: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  const mount = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | null>(null);
  const font = useTerminalStore((s) => s.fontFamily);
  const weight = useTerminalStore((s) => s.terminalWeight);
  const themeName = useTerminalStore((s) => s.themeName);
  const scheme = useTheme().resolvedTheme === "light" ? "light" : "dark";
  const theme = useMemo(() => getTerminalTheme(themeName, scheme), [themeName, scheme]);

  useEffect(() => {
    const parent = host.current!;
    const element = mount.current!;
    const term = new Terminal({
      cols: frame.cols,
      rows: frame.rows,
      scrollback: 0,
      disableStdin: true,
      fontFamily: terminalFontFamily(font),
      fontSize: 14,
      fontWeight: weight,
      fontWeightBold: 700,
      lineHeight: 1,
      cursorBlink: false,
      theme: terminalThemeToXterm(theme),
      allowProposedApi: true,
      overviewRulerWidth: 0,
    });
    const unicode = new Unicode11Addon();
    term.loadAddon(unicode);
    term.unicode.activeVersion = "11";
    term.open(element);
    terminal.current = term;
    const fit = () => {
      const screen = element.querySelector<HTMLElement>(".xterm-screen");
      if (!screen?.offsetWidth || !screen.offsetHeight) return;
      const fitted = Math.min(
        parent.clientWidth / screen.offsetWidth,
        parent.clientHeight / screen.offsetHeight,
      );
      // Gallery cards keep text at least 12px. Keep the latest terminal
      // rows and first columns visible when zoom crops, without resizing tmux.
      const scale = readable ? Math.max(fitted, 12 / 14) : fitted;
      element.style.transform = `scale(${scale})`;
      element.style.left = readable
        ? "0px"
        : `${(parent.clientWidth - screen.offsetWidth * scale) / 2}px`;
      const verticalSpace = parent.clientHeight - screen.offsetHeight * scale;
      element.style.top = `${verticalSpace < 0 ? verticalSpace : verticalSpace / 2}px`;
    };
    const observer = new ResizeObserver(fit);
    observer.observe(parent);
    const screen = element.querySelector(".xterm-screen");
    if (screen) observer.observe(screen);
    void refreshWhenFontLoads(term, document.fonts, fit);
    fit();
    return () => {
      observer.disconnect();
      terminal.current = null;
      term.dispose();
      element.replaceChildren();
    };
  }, [frame.cols, frame.rows, font, weight, theme, readable]);

  useEffect(() => {
    // capture-pane ends every row with LF. Drop the final LF to avoid scrolling.
    terminal.current?.write(
      "\x1b[0m\x1b[2J\x1b[H\x1b[?25l\x1b[?7l" +
        frame.content.replace(/\n$/, "").replace(/\n/g, "\r\n"),
    );
  }, [frame, font, weight, theme, readable]);

  return (
    <div
      ref={host}
      aria-hidden
      inert
      className="pointer-events-none absolute inset-0 overflow-hidden"
      style={{ backgroundColor: theme.background }}
    >
      <div
        ref={mount}
        className="absolute origin-top-left"
        style={{ width: frame.cols * 20, height: frame.rows * 20 }}
      />
    </div>
  );
}
