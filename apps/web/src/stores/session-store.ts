import { create } from "zustand";
import type { SessionInfo } from "@repo/protocol";

interface SessionStore {
  sessions: SessionInfo[];
  sessionsLoaded: boolean;
  activeSessionId: string | null;
  openedSessions: string[];
  setSessions: (sessions: SessionInfo[]) => void;
  addSession: (session: SessionInfo) => void;
  removeSession: (name: string) => void;
  updateSessionActivity: (name: string, activity: string) => void;
  setActiveSession: (name: string | null) => void;
  openSession: (name: string) => void;
}

export const useSessionStore = create<SessionStore>((set, get) => ({
  sessions: [],
  sessionsLoaded: false,
  activeSessionId: null,
  openedSessions: [],
  setSessions: (sessions) => set({ sessions, sessionsLoaded: true }),
  addSession: (session) =>
    set((s) => ({
      sessions: [...s.sessions.filter((x) => x.name !== session.name), session],
    })),
  removeSession: (name) =>
    set((s) => {
      const openedSessions = s.openedSessions.filter((n) => n !== name);
      const activeSessionId =
        s.activeSessionId === name
          ? (openedSessions[openedSessions.length - 1] ?? null)
          : s.activeSessionId;
      return {
        sessions: s.sessions.filter((x) => x.name !== name),
        openedSessions,
        activeSessionId,
      };
    }),
  updateSessionActivity: (name, activity) =>
    set((s) => ({
      sessions: s.sessions.map((x) =>
        x.name === name ? { ...x, activity } : x,
      ),
    })),
  setActiveSession: (name) => {
    if (name) {
      get().openSession(name);
    }
    if (name !== get().activeSessionId) {
      set({ activeSessionId: name });
    }
  },
  openSession: (name) =>
    set((s) =>
      s.openedSessions.includes(name)
        ? s
        : { openedSessions: [...s.openedSessions, name] },
    ),
}));
