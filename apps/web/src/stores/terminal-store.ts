import { create } from "zustand";
import { persist } from "zustand/middleware";
import { DEFAULT_TERMINAL_FONT } from "@/lib/terminal-font.js";

export function getDefaultFontSize(): number {
  if (typeof window === "undefined") return 14;
  const width = window.innerWidth;
  if (width <= 480) return 14;
  if (width <= 768) return 14;
  if (width <= 1024) return 13;
  return 14;
}

/** Clamp font size to a range that produces readable terminal on the current viewport */
export function clampFontSize(size: number): number {
  if (typeof window === "undefined") return Math.max(8, Math.min(24, size));
  const width = window.innerWidth;
  // On mobile, cap font size so terminal has at least ~20 cols visible
  // Approx: cols ≈ (width - scrollbar) / (fontSize * 0.6)
  // For 20 cols: maxFont ≈ width / (20 * 0.6) ≈ width / 12
  const maxForViewport = Math.floor(width / 12);
  const max = Math.min(24, Math.max(14, maxForViewport));
  return Math.max(8, Math.min(max, size));
}

interface TerminalStore {
  fontSize: number;
  fontFamily: string;
  themeName: string;
  cursorStyle: "block" | "underline" | "bar";
  cursorBlink: boolean;
  scrollback: number;
  /**
   * Use xterm's WebGL renderer. Faster, but it mis-scales cells by
   * devicePixelRatio on HiDPI screens — see terminal-view.tsx. Turn it off if
   * only part of each line is visible.
   */
  gpuRendering: boolean;
  setFontSize: (size: number) => void;
  setFontFamily: (family: string) => void;
  setThemeName: (name: string) => void;
  setCursorStyle: (style: "block" | "underline" | "bar") => void;
  setCursorBlink: (blink: boolean) => void;
  setScrollback: (lines: number) => void;
  setGpuRendering: (on: boolean) => void;
}

export const useTerminalStore = create<TerminalStore>()(
  persist(
    (set) => ({
      fontSize: getDefaultFontSize(),
      fontFamily: DEFAULT_TERMINAL_FONT,
      themeName: "dracula",
      cursorStyle: "block",
      cursorBlink: true,
      scrollback: 5000,
      gpuRendering: true,
      setFontSize: (fontSize) => set({ fontSize: clampFontSize(fontSize) }),
      setFontFamily: (fontFamily) => set({ fontFamily }),
      setThemeName: (themeName) => set({ themeName }),
      setCursorStyle: (cursorStyle) => set({ cursorStyle }),
      setCursorBlink: (cursorBlink) => set({ cursorBlink }),
      setScrollback: (scrollback) => set({ scrollback }),
      setGpuRendering: (gpuRendering) => set({ gpuRendering }),
    }),
    { name: "ccremote-terminal" },
  ),
);
