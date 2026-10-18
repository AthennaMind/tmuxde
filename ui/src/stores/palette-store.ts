import { create } from "zustand";
import { onDisconnectAll } from "@/lib/relay-registry";
import type { PaletteMode } from "@/lib/palette-key";

export type { PaletteMode };

/** A second step that reuses the palette input, such as a new window name. */
export interface PalettePrompt {
  label: string;
  placeholder: string;
  hint: string;
  initial?: string;
  submit: (value: string) => void;
}

/** A destructive step confirmed after the palette closes. */
export interface PaletteConfirm {
  title: string;
  description: string;
  label: string;
  run: () => void;
}

interface PaletteState {
  open: boolean;
  mode: PaletteMode;
  prompt: PalettePrompt | null;
  confirm: PaletteConfirm | null;
}

export const usePaletteStore = create<PaletteState>(() => ({
  open: false,
  mode: "commands",
  prompt: null,
  confirm: null,
}));

export function openPalette(mode: PaletteMode = "commands"): void {
  usePaletteStore.setState({ open: true, mode, prompt: null });
}

/** A shortcut press opens its mode, switches to it, or closes it again. */
export function togglePalette(mode: PaletteMode): void {
  const state = usePaletteStore.getState();
  if (state.open && state.mode === mode && !state.prompt) closePalette();
  else openPalette(mode);
}

export function closePalette(): void {
  usePaletteStore.setState({ open: false, prompt: null });
}

export function promptInPalette(prompt: PalettePrompt): void {
  usePaletteStore.setState({ prompt });
}

export function confirmAfterPalette(confirm: PaletteConfirm): void {
  usePaletteStore.setState({ open: false, prompt: null, confirm });
}

// Lock or sign out closes every palette step, including pending confirmations.
onDisconnectAll(() => usePaletteStore.setState({ open: false, prompt: null, confirm: null }));
