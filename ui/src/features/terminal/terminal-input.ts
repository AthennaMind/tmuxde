import { create } from "zustand";

type InputState = {
  ctrl: boolean;
  alt: boolean;
  toggle: (key: "ctrl" | "alt") => void;
  reset: () => void;
};

export const useTerminalInput = create<InputState>()((set) => ({
  ctrl: false,
  alt: false,
  toggle: (key) => set((state) => ({ [key]: !state[key] })),
  reset: () => set({ ctrl: false, alt: false }),
}));

export function consumeTerminalInput(data: string) {
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
