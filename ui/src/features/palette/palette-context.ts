import { createContext, useContext } from "react";
import type { PaletteMode } from "./palette-key";

export interface PaletteContextValue {
  query: string;
  /** Close and choose focus destination. Editor navigation owns its focus. */
  finish: (focus?: "terminal" | "editor") => void;
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
