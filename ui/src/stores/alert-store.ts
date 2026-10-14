import { create } from "zustand";

interface Alert {
  id: string;
  type: "info" | "success" | "warning" | "error";
  message: string;
  timestamp: number;
}

interface AlertStore {
  alerts: Alert[];
  push: (type: Alert["type"], message: string) => void;
  dismiss: (id: string) => void;
  dismissAll: () => void;
}

let nextId = 0;

const AUTO_DISMISS_MS: Record<Alert["type"], number> = {
  info: 4000,
  success: 4000,
  warning: 6000,
  error: 6000,
};

const MAX_ALERTS = 5;
const DEDUP_WINDOW_MS = 2000;

export const useAlertStore = create<AlertStore>((set, get) => ({
  alerts: [],
  push: (type, message) => {
    const now = Date.now();
    // Deduplicate by message within 2s window
    const existing = get().alerts.find(
      (a) => a.message === message && now - a.timestamp < DEDUP_WINDOW_MS,
    );
    if (existing) return;

    const id = `alert-${++nextId}`;
    const alert: Alert = { id, type, message, timestamp: now };

    set((s) => ({
      alerts: [...s.alerts.slice(-(MAX_ALERTS - 1)), alert],
    }));

    // Auto-dismiss
    setTimeout(() => {
      set((s) => ({ alerts: s.alerts.filter((a) => a.id !== id) }));
    }, AUTO_DISMISS_MS[type]);
  },
  dismiss: (id) =>
    set((s) => ({ alerts: s.alerts.filter((a) => a.id !== id) })),
  dismissAll: () => set({ alerts: [] }),
}));
