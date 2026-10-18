import { createContext, useContext } from "react";
import type { PaletteMode } from "./palette-key";

export interface PaletteContextValue {
  query: string;
  /** Close, then return focus to the opener or to the terminal. */
  finish: (focus?: "terminal") => void;
  setMode: (mode: PaletteMode) => void;
  /** Show a spinner in the input while a mode waits on the network. */
  setBusy: (busy: boolean) => void;
}

export const PaletteContext = createContext<PaletteContextValue | null>(null);

export function usePalette(): PaletteContextValue {
  const value = useContext(PaletteContext);
  if (!value) throw new Error("usePalette outside Palette");
  return value;
}
