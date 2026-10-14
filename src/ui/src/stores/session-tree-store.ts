import { create } from "zustand";
import type { PaneInfo, WindowInfo } from "@/protocol";

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
  /**
   * Counts every `session:attached`, so a request answered while the relay
   * had no session (a remount between the phone and desktop layouts detaches
   * and attaches again) is asked again once the attach lands, even when the
   * session name did not change.
   */
  attachCount: number;
  setDetails: (name: string, details: SessionDetails) => void;
  setLoading: (name: string, loading: boolean) => void;
  setAttachedSession: (name: string | null) => void;
  forget: (name: string) => void;
}

export const useSessionTreeStore = create<SessionTreeStore>((set) => ({
  details: {},
  loading: {},
  attachedSession: null,
  attachCount: 0,
  setDetails: (name, details) =>
    set((s) => ({
      details: { ...s.details, [name]: details },
      loading: { ...s.loading, [name]: false },
    })),
  setLoading: (name, loading) =>
    set((s) => ({ loading: { ...s.loading, [name]: loading } })),
  setAttachedSession: (attachedSession) =>
    set((s) => ({
      attachedSession,
      attachCount:
        attachedSession === null ? s.attachCount : s.attachCount + 1,
    })),
  forget: (name) =>
    set((s) => {
      const details = { ...s.details };
      const loading = { ...s.loading };
      delete details[name];
      delete loading[name];
      return { details, loading };
    }),
}));
