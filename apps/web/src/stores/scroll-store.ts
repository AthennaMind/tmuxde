import { create } from "zustand";

/**
 * Where the attached pane's view sits inside tmux's history.
 *
 * Mirrors the relay's `tmux:scroll-state`. It is a *report*, not a control:
 * nothing here moves the pane — `lib/terminal-scroll.ts` does that, and the
 * relay answers with the position it actually reached. Drawing the rail from
 * anything else (a locally predicted position, say) makes the thumb argue with
 * the terminal every time output arrives mid-drag.
 */
interface ScrollStore {
  /** Lines scrolled back from the live output; 0 is the bottom. */
  position: number;
  /** Lines of history above the visible rows. */
  historySize: number;
  paneHeight: number;
  /** tmux's `pane_in_mode` — false means the pane is showing live output. */
  inMode: boolean;
  /** False until the relay has answered once, so the rail can stay quiet. */
  known: boolean;
  setScrollState: (state: {
    position: number;
    historySize: number;
    paneHeight: number;
    inMode: boolean;
  }) => void;
  /** Forget the report — on detach, or a switch to another session. */
  clearScrollState: () => void;
}

export const useScrollStore = create<ScrollStore>((set) => ({
  position: 0,
  historySize: 0,
  paneHeight: 0,
  inMode: false,
  known: false,
  setScrollState: (state) => set({ ...state, known: true }),
  clearScrollState: () =>
    set({
      position: 0,
      historySize: 0,
      paneHeight: 0,
      inMode: false,
      known: false,
    }),
}));
