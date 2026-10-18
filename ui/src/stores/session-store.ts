import { create } from "zustand";
import type { SessionInfo } from "@/protocol";

interface SessionStore {
  sessions: SessionInfo[];
  sessionsLoaded: boolean;
  activeSessionId: string | null;
  openedSessions: string[];
  setSessions: (sessions: SessionInfo[]) => void;
  addSession: (session: SessionInfo) => void;
  removeSession: (name: string) => void;
  /** Follow a rename: the list entry, the opened tabs and the active one. */
  renameSession: (from: string, to: string) => void;
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
  renameSession: (from, to) =>
    set((s) => {
      if (from === to) return s;
      const openedSessions = s.openedSessions
        .map((n) => (n === from ? to : n))
        .filter((n, i, all) => all.indexOf(n) === i);
      return {
        sessions: s.sessions
          .filter((x) => x.name !== to)
          .map((x) => (x.name === from ? { ...x, name: to } : x)),
        openedSessions,
        activeSessionId: s.activeSessionId === from ? to : s.activeSessionId,
      };
    }),
  updateSessionActivity: (name, activity) =>
    set((s) => ({
      sessions: s.sessions.map((x) => (x.name === name ? { ...x, activity } : x)),
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
      s.openedSessions.includes(name) ? s : { openedSessions: [...s.openedSessions, name] },
    ),
}));
