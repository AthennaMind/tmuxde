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

export const CODE_ZOOM_MIN = 0.7;
export const CODE_ZOOM_MAX = 2;
export const CODE_ZOOM_STEP = 0.1;

export function clampCodeZoom(zoom: number): number {
  const clamped = Math.min(CODE_ZOOM_MAX, Math.max(CODE_ZOOM_MIN, zoom));
  // Tenths, so repeated steps do not drift to 1.0999999.
  return Math.round(clamped * 10) / 10;
}

/** Weights the variable code face carries. Bold text uses 700. */
export const CODE_WEIGHTS = [400, 500, 600, 700] as const;
export type CodeWeight = (typeof CODE_WEIGHTS)[number];

interface TerminalStore {
  fontSize: number;
  fontFamily: string;
  /** Text weight in terminal, file and diff views and the editor. */
  codeWeight: CodeWeight;
  /**
   * Scale of file, diff and editor text. Separate from `fontSize`: the
   * terminal font sets the pty size, so zooming a file must not resize tmux.
   */
  codeZoom: number;
  themeName: string;
  cursorStyle: "block" | "underline" | "bar";
  cursorBlink: boolean;
  scrollback: number;
  /**
   * Use xterm's WebGL renderer on desktop. Faster with heavy output, but text
   * comes from a glyph atlas and looks softer than the DOM renderer's, and it
   * mis-scales cells on some HiDPI screens. See terminal-view.tsx. Off by
   * default.
   */
  gpuRendering: boolean;
  setFontSize: (size: number) => void;
  setFontFamily: (family: string) => void;
  setCodeWeight: (weight: CodeWeight) => void;
  setCodeZoom: (zoom: number) => void;
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
      // Heavy, with room left for bold. At 700, bold output would look like
      // everything else.
      codeWeight: 600,
      codeZoom: 1,
      themeName: "dracula",
      cursorStyle: "block",
      cursorBlink: true,
      scrollback: 5000,
      gpuRendering: false,
      setFontSize: (fontSize) => set({ fontSize: clampFontSize(fontSize) }),
      setFontFamily: (fontFamily) => set({ fontFamily }),
      setCodeWeight: (codeWeight) => set({ codeWeight }),
      setCodeZoom: (codeZoom) => set({ codeZoom: clampCodeZoom(codeZoom) }),
      setThemeName: (themeName) => set({ themeName }),
      setCursorStyle: (cursorStyle) => set({ cursorStyle }),
      setCursorBlink: (cursorBlink) => set({ cursorBlink }),
      setScrollback: (scrollback) => set({ scrollback }),
      setGpuRendering: (gpuRendering) => set({ gpuRendering }),
    }),
    {
      name: "ccremote-terminal",
      // Version 1 turned GPU rendering off by default. Stored state from
      // before saved the old default `true`, which was never a choice.
      version: 1,
      migrate: (persisted, version) => {
        const state = persisted as Partial<TerminalStore>;
        return version < 1 ? { ...state, gpuRendering: false } : state;
      },
    },
  ),
);
