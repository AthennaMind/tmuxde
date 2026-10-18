import { create } from "zustand";

/**
 * - `starting`: asking for the microphone.
 * - `listening`: recording. Speech already counts even if the speech service
 *   has not answered yet; audio waits on the device until it does.
 * - `stopping`: microphone muted, the last words are being transcribed.
 */
export type DictationStatus = "idle" | "starting" | "listening" | "stopping";

interface DictationStore {
  status: DictationStatus;
  /** Input level, 0 to 1, for the meter. */
  level: number;
  /** When recording began, for the elapsed time. */
  startedAt: number | null;
}

export const useDictationStore = create<DictationStore>(() => ({
  status: "idle",
  level: 0,
  startedAt: null,
}));
