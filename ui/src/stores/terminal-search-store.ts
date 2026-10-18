import { create } from "zustand";
import type { TerminalSearchResultMessage } from "@/protocol";
import { sessionLocks } from "@/lib/lock-store";
import { get as getClient, onDisconnectAll } from "@/lib/relay-registry";
import { useMachineStore } from "./machine-store";

export interface MachineSearch {
  id: string;
  name: string;
  state: "searching" | "done" | "offline" | "unsupported" | "error";
  excluded: number;
  result?: TerminalSearchResultMessage;
  error?: string;
}

interface TerminalSearchStore {
  query: string;
  caseSensitive: boolean;
  requestId: string | null;
  machines: MachineSearch[];
}

const initial: TerminalSearchStore = {
  query: "",
  caseSensitive: false,
  requestId: null,
  machines: [],
};

export const useTerminalSearchStore = create<TerminalSearchStore>(() => initial);
let timeout: ReturnType<typeof setTimeout> | undefined;

export function resetTerminalSearch(): void {
  clearTimeout(timeout);
  useTerminalSearchStore.setState(initial);
}

export function receiveTerminalSearch(
  machineId: string,
  result: TerminalSearchResultMessage,
): void {
  useTerminalSearchStore.setState((state) => {
    if (state.requestId !== result.requestId) return state;
    return {
      machines: state.machines.map((machine) =>
        machine.id === machineId && machine.state === "searching"
          ? { ...machine, state: result.error ? "error" : "done", result, error: result.error }
          : machine,
      ),
    };
  });
  if (
    !useTerminalSearchStore.getState().machines.some((machine) => machine.state === "searching")
  ) {
    clearTimeout(timeout);
  }
}

export function terminalSearchDisconnected(machineId: string): void {
  useTerminalSearchStore.setState((state) => ({
    machines: state.machines.map((machine) =>
      machine.id === machineId && machine.state === "searching"
        ? { ...machine, state: "error", error: "Connection lost. Search again after reconnecting." }
        : machine,
    ),
  }));
}

/** Inventory connections search every machine without changing active workspace. */
export function searchTerminals(query: string, caseSensitive: boolean): void {
  if (!query.trim() || query.length > 256 || /[\r\n\x00]/.test(query)) return;
  if (useTerminalSearchStore.getState().machines.some((machine) => machine.state === "searching"))
    return;
  clearTimeout(timeout);
  const requestId = crypto.randomUUID();
  const machines: MachineSearch[] = useMachineStore.getState().machines.map((machine) => ({
    id: machine.id,
    name: machine.name,
    state: !machine.online
      ? "offline"
      : !machine.features.includes("terminal:search")
        ? "unsupported"
        : getClient(`inventory:${machine.id}`)?.status !== "connected"
          ? "error"
          : "searching",
    excluded: Object.keys(sessionLocks(machine.id)).length,
    error: "Machine is reconnecting. Try again shortly.",
  }));
  useTerminalSearchStore.setState({ query, caseSensitive, requestId, machines });
  timeout = setTimeout(() => {
    if (useTerminalSearchStore.getState().requestId !== requestId) return;
    useTerminalSearchStore.setState((state) => ({
      machines: state.machines.map((machine) =>
        machine.state === "searching"
          ? { ...machine, state: "error", error: "Search timed out. Try again." }
          : machine,
      ),
    }));
  }, 15_000);
  for (const machine of machines) {
    if (machine.state !== "searching") continue;
    const excludeSessions = Object.keys(sessionLocks(machine.id));
    if (excludeSessions.length > 1024) {
      terminalSearchDisconnected(machine.id);
      continue;
    }
    getClient(`inventory:${machine.id}`)?.send({
      type: "terminal:search",
      requestId,
      query,
      caseSensitive,
      excludeSessions,
    });
  }
}

onDisconnectAll(resetTerminalSearch);
