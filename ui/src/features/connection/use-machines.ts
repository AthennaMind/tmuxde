import {
  receiveTerminalPreview,
  previewConnectionChanged,
  resetPreviews,
} from "@/features/panes/terminal-preview-store";
import { useEffect } from "react";
import { MachineListSchema } from "@/protocol/machines";
import { RelayClient } from "./ws-client";
import { resolveRelayHttpBase, resolveRelayWsUrl } from "./relay-url";
import { findRenames } from "@/features/session/session-lifecycle";
import { isMachineTab, useMainTabsStore } from "@/features/workspace/main-tabs-store";
import { useMachineStore } from "./machine-store";
import * as registry from "./relay-registry";
import {
  receiveTerminalSearch,
  resetTerminalSearch,
  terminalSearchDisconnected,
} from "@/features/palette/terminal-search-store";

/** Read-only subscriptions keep every machine live without attaching a PTY. */
export function useMachines(token: string) {
  useEffect(() => {
    if (!token) return;
    const controller = new AbortController();
    const clients = new Map<string, RelayClient>();
    let timer: ReturnType<typeof setTimeout>;

    const connect = (id: string) => {
      const key = `inventory:${id}`;
      const client = registry.acquire(
        key,
        () =>
          new RelayClient({
            url: resolveRelayWsUrl(id),
            token,
            onStatusChange: (status) => {
              useMachineStore.getState().update(id, { status });
              previewConnectionChanged(id);
              if (status !== "connected") terminalSearchDisconnected(id);
            },
            onMessage: (message) => {
              if (controller.signal.aborted) return;
              const store = useMachineStore.getState();
              if (message.type === "terminal:preview:frame") {
                receiveTerminalPreview(id, message);
              } else if (message.type === "terminal:search:result") {
                receiveTerminalSearch(id, message);
              } else if (message.type === "auth:success") {
                client.send({ type: "session:list" });
              } else if (message.type === "session:list") {
                const previous = store.inventory[id]?.sessions ?? [];
                const renames = new Map(findRenames(previous, message.sessions));
                if (renames.size) {
                  useMainTabsStore.setState((state) => ({
                    tabs: state.tabs.map((tab) =>
                      isMachineTab(tab) &&
                      (tab.machineId ?? "local") === id &&
                      tab.sessionName &&
                      renames.has(tab.sessionName)
                        ? { ...tab, sessionName: renames.get(tab.sessionName)! }
                        : tab,
                    ),
                  }));
                }
                useMachineStore.setState((state) => ({
                  terminals: state.terminals.flatMap((tab) => {
                    if (tab.machineId !== id) return [tab];
                    const name = renames.get(tab.sessionName) ?? tab.sessionName;
                    return message.sessions.some((session) => session.name === name)
                      ? [{ ...tab, sessionName: name }]
                      : [];
                  }),
                }));
                store.update(id, { sessions: message.sessions, loaded: true });
                for (const session of message.sessions) {
                  client.send({ type: "session:windows", name: session.name });
                }
              } else if (message.type === "session:windows") {
                store.update(id, {
                  details: {
                    ...store.inventory[id]?.details,
                    [message.name]: { windows: message.windows, panes: message.panes },
                  },
                });
              } else if (message.type === "session:activity") {
                store.update(id, {
                  sessions: (store.inventory[id]?.sessions ?? []).map((session) =>
                    session.name === message.name
                      ? { ...session, activity: message.activity }
                      : session,
                  ),
                });
              }
            },
          }),
      );
      clients.set(id, client);
      client.connect();
    };

    const load = async () => {
      try {
        // oxlint-disable-next-line no-restricted-globals -- sanctioned machine inventory request.
        const response = await fetch(`${resolveRelayHttpBase()}/machines`, {
          headers: { Authorization: `Bearer ${token}` },
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) throw new Error("Machine inventory unavailable");
        const machines = MachineListSchema.parse(await response.json());
        if (controller.signal.aborted) return;
        useMachineStore.setState({ machines, loaded: true, error: false });
        for (const [id] of clients) {
          if (!machines.some((machine) => machine.id === id && machine.online)) {
            registry.release(`inventory:${id}`);
            clients.delete(id);
          }
        }
        for (const machine of machines) {
          if (!machine.online) continue;
          if (!clients.has(machine.id)) connect(machine.id);
          else {
            const client = clients.get(machine.id)!;
            if (client.status === "connected") {
              // Refresh folders and commands even when a pane is idle.
              for (const session of useMachineStore.getState().inventory[machine.id]?.sessions ??
                []) {
                client.send({ type: "session:windows", name: session.name });
              }
            }
          }
        }
      } catch {
        if (!controller.signal.aborted) useMachineStore.setState({ error: true });
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(load, 5000);
      }
    };
    void load();
    return () => {
      controller.abort();
      resetTerminalSearch();
      resetPreviews();
      clearTimeout(timer);
      for (const [id] of clients) registry.release(`inventory:${id}`);
      useMachineStore.setState({ inventory: {}, machines: [], loaded: false });
    };
  }, [token]);
}
