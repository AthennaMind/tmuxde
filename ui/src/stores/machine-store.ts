import { createJSONStorage, persist } from "zustand/middleware";
import { tabStorage } from "./main-tabs-store";
import { create } from "zustand";
import type { ClientMessage, ConnectionState, SessionInfo } from "@/protocol";
import type { MachineInfo } from "@/protocol/machines";
import type { SessionDetails } from "./session-tree-store";
import { machineId, setMachineId } from "@/lib/machine-context";

export interface MachineSessions {
  status: ConnectionState;
  loaded: boolean;
  sessions: SessionInfo[];
  details: Record<string, SessionDetails>;
}

export interface TerminalTab {
  machineId: string;
  sessionName: string;
}

export interface WorkspaceTarget extends TerminalTab {
  tabId: string;
  messages: ClientMessage[];
}

interface MachineStore {
  machines: MachineInfo[];
  inventory: Record<string, MachineSessions>;
  error: boolean;
  loaded: boolean;
  activeMachine: string;
  requested: WorkspaceTarget | null;
  pendingAction: (WorkspaceTarget & { expires: number }) | null;
  createSession: boolean;
  unlockTarget: WorkspaceTarget | null;
  capture: { machineId: string; paneId: string; expires: number } | null;
  terminals: TerminalTab[];
  update: (id: string, patch: Partial<MachineSessions>) => void;
  openTerminal: (machineId: string, sessionName: string) => void;
  closeTerminal: (machineId: string, sessionName: string) => void;
}

export const useMachineStore = create<MachineStore>()(
  persist(
    (set) => ({
      machines: [],
      inventory: {},
      error: false,
      loaded: false,
      activeMachine: machineId(),
      requested: null,
      pendingAction: null,
      createSession: false,
      unlockTarget: null,
      capture: null,
      terminals: [],
      update: (id, patch) =>
        set((s) => ({
          inventory: {
            ...s.inventory,
            [id]: {
              status: "disconnected",
              loaded: false,
              sessions: [],
              details: {},
              ...s.inventory[id],
              ...patch,
            },
          },
        })),
      openTerminal: (tabMachineId, sessionName) =>
        set((s) =>
          s.terminals.some(
            (tab) => tab.machineId === tabMachineId && tab.sessionName === sessionName,
          )
            ? s
            : { terminals: [...s.terminals, { machineId: tabMachineId, sessionName }] },
        ),
      closeTerminal: (tabMachineId, sessionName) =>
        set((s) => ({
          terminals: s.terminals.filter(
            (tab) => tab.machineId !== tabMachineId || tab.sessionName !== sessionName,
          ),
        })),
    }),
    {
      name: "tmuxde-terminal-tabs",
      storage: createJSONStorage(() => tabStorage),
      partialize: (state) => ({ terminals: state.terminals, activeMachine: state.activeMachine }),
      merge: (persisted, current) => {
        const saved = persisted as Partial<MachineStore> | undefined;
        const terminals = Array.isArray(saved?.terminals)
          ? saved.terminals.filter(
              (tab) =>
                typeof tab?.machineId === "string" &&
                /^[a-zA-Z0-9_-]+$/.test(tab.machineId) &&
                typeof tab.sessionName === "string",
            )
          : [];
        const restoreMachine = typeof window !== "undefined" && window.location?.pathname === "/";
        const activeMachine =
          restoreMachine &&
          typeof saved?.activeMachine === "string" &&
          /^[a-zA-Z0-9_-]+$/.test(saved.activeMachine)
            ? saved.activeMachine
            : current.activeMachine;
        if (restoreMachine) setMachineId(activeMachine);
        return { ...current, terminals, activeMachine };
      },
    },
  ),
);
