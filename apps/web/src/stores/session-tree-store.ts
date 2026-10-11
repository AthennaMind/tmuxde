import { create } from "zustand";
import type { PaneInfo, WindowInfo } from "@repo/protocol";

export interface SessionDetails {
  windows: WindowInfo[];
  panes: PaneInfo[];
}

/**
 * Windows and panes per session, for the desktop session tree.
 *
 * `pane-store` only knows the attached session and only the panes of the
 * window on screen. The tree shows every window of every expanded session,
 * so it keeps its own `session:windows` snapshots here.
 */
interface SessionTreeStore {
  details: Record<string, SessionDetails>;
  loading: Record<string, boolean>;
  /**
   * Session the relay confirmed with `session:attached`.
   *
   * `activeSessionId` changes the moment a session is picked. The relay only
   * accepts window and pane commands once the attach lands, and `pane-store`
   * still holds the previous session until then.
   */
  attachedSession: string | null;
  setDetails: (name: string, details: SessionDetails) => void;
  setLoading: (name: string, loading: boolean) => void;
  setAttachedSession: (name: string | null) => void;
  forget: (name: string) => void;
}

export const useSessionTreeStore = create<SessionTreeStore>((set) => ({
  details: {},
  loading: {},
  attachedSession: null,
  setDetails: (name, details) =>
    set((s) => ({
      details: { ...s.details, [name]: details },
      loading: { ...s.loading, [name]: false },
    })),
  setLoading: (name, loading) =>
    set((s) => ({ loading: { ...s.loading, [name]: loading } })),
  setAttachedSession: (attachedSession) => set({ attachedSession }),
  forget: (name) =>
    set((s) => {
      const details = { ...s.details };
      const loading = { ...s.loading };
      delete details[name];
      delete loading[name];
      return { details, loading };
    }),
}));
