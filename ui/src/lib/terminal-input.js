// @ts-check
import { create } from "zustand";

/**
 * @typedef {{ctrl: boolean, alt: boolean, toggle: (key: "ctrl" | "alt") => void, reset: () => void}} InputState
 */

/** @type {import("zustand").UseBoundStore<import("zustand").StoreApi<InputState>>} */
export const useTerminalInput = create((set) => ({
  ctrl: false,
  alt: false,
  toggle: (key) => set((state) => ({ [key]: !state[key] })),
  reset: () => set({ ctrl: false, alt: false }),
}));

/** @param {string} data */
export function consumeTerminalInput(data) {
  if (!data) return data;
  const { ctrl, alt, reset } = useTerminalInput.getState();
  if (!ctrl && !alt) return data;

  // xterm sends protocol replies through onData too. Only keyboard sequences
  // may consume a modifier. Bracketed paste clears it without changing text.
  if (data.startsWith("\x1b[200~")) {
    reset();
    return data;
  }
  const keySequence =
    data.startsWith("\x1b") &&
    (/^(?:\[[0-9;]*[ABCDHFZ~]|O[ABCDHFPQRS])$/.test(data.slice(1)) ||
      (data.length === 2 && !["[", "]", "O", "P", "\x1b"].includes(data.charAt(1))));
  if (data.startsWith("\x1b") && data.length > 1 && !keySequence) return data;
  reset();

  // Pasted or composed text must stay intact.
  if (data.length !== 1 && !keySequence) return data;
  let result = data;
  if (ctrl && data.length === 1) {
    const code = data.toUpperCase().charCodeAt(0);
    if (data === " ") result = "\x00";
    else if (data === "?") result = "\x7f";
    else if (code >= 64 && code <= 95) result = String.fromCharCode(code - 64);
  }
  return alt ? "\x1b" + result : result;
}
