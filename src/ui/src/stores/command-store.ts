import { machineId, machineStorageKey } from "@/lib/machine-context";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { isEnrolled } from "@/lib/unlocked";

const LEGACY_KEY = "ccremote-commands";

interface Snippet {
  id: string;
  name: string;
  command: string;
  pinned: boolean;
}

interface CommandStore {
  history: string[];
  snippets: Snippet[];
  addToHistory: (command: string) => void;
  clearHistory: () => void;
  addSnippet: (snippet: Omit<Snippet, "id">) => void;
  removeSnippet: (id: string) => void;
  togglePinned: (id: string) => void;
}

export const useCommandStore = create<CommandStore>()(
  persist(
    (set) => ({
      history: [],
      snippets: [],
      addToHistory: (command) =>
        set((s) => ({
          history: [command, ...s.history.filter((c) => c !== command)].slice(
            0,
            100,
          ),
        })),
      clearHistory: () => set({ history: [] }),
      addSnippet: (snippet) =>
        set((s) => ({
          snippets: [...s.snippets, { ...snippet, id: crypto.randomUUID() }],
        })),
      removeSnippet: (id) =>
        set((s) => ({
          snippets: s.snippets.filter((x) => x.id !== id),
        })),
      togglePinned: (id) =>
        set((s) => ({
          snippets: s.snippets.map((x) =>
            x.id === id ? { ...x, pinned: !x.pinned } : x,
          ),
        })),
    }),
    {
      name: machineStorageKey("tmuxde-commands"),
      /**
       * Stop writing to `localStorage` once a device lock is enrolled.
       *
       * The last hundred commands you ran are as revealing as the terminal
       * itself — hostnames, paths, the occasional secret pasted into a shell —
       * and `localStorage` is readable by any script on the origin and survives
       * a lock. Encrypting them would mean the command palette could not paint
       * until the device was open, for something that is a convenience; not
       * persisting them is the honest trade.
       *
       * A device with no lock keeps exactly today's behaviour.
       */
      storage: guardedStorage(),
      partialize: (state) => ({
        history: state.history,
        snippets: state.snippets,
      }),
    },
  ),
);

function guardedStorage() {
  return createJSONStorage(() => {
    if (typeof window === "undefined") return memoryStorage();
    return {
      getItem: (key: string) =>
        // The store used to be called `ccremote-commands`. Reading the old key
        // when the new one is empty keeps people's saved snippets across the
        // rename; nothing writes it back, so it ages out on its own.
        window.localStorage.getItem(key) ??
        (machineId() === "local" ? window.localStorage.getItem(LEGACY_KEY) : null),
      setItem: (key: string, value: string) => {
        if (isEnrolled()) {
          // Also clear what an earlier, unlocked session already wrote.
          window.localStorage.removeItem(key);
          return;
        }
        window.localStorage.setItem(key, value);
      },
      removeItem: (key: string) => window.localStorage.removeItem(key),
    };
  });
}

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key: string) => map.get(key) ?? null,
    key: (index: number) => Array.from(map.keys())[index] ?? null,
    removeItem: (key: string) => void map.delete(key),
    setItem: (key: string, value: string) => void map.set(key, value),
  };
}
