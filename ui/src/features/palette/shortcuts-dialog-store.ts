import { create } from "zustand";

/** Opened by `?` and by the command palette. */
export const useShortcutsDialog = create<{ open: boolean }>(() => ({ open: false }));
