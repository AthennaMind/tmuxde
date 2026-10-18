import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientMessage, TerminalSearchResultMessage } from "@/protocol";
import type { MachineInfo } from "@/protocol/machines";

const fixture = vi.hoisted(() => ({
  machines: [] as MachineInfo[],
  clients: new Map<string, { status: string; send: ReturnType<typeof vi.fn> }>(),
  locks: {} as Record<string, Record<string, true>>,
  disconnect: () => {},
}));
vi.mock("@/lib/lock-store", () => ({ sessionLocks: (id: string) => fixture.locks[id] ?? {} }));
vi.mock("./machine-store", () => ({ useMachineStore: { getState: () => ({ machines: fixture.machines }) } }));
vi.mock("@/lib/relay-registry", () => ({
  get: (key: string) => fixture.clients.get(key),
  onDisconnectAll: (handler: () => void) => { fixture.disconnect = handler; },
}));

import {
  receiveTerminalSearch, resetTerminalSearch, searchTerminals,
  terminalSearchDisconnected, useTerminalSearchStore,
} from "./terminal-search-store";

const machine = (id: string): MachineInfo => ({
  id, name: id, online: true, hostname: id, platform: "linux",
  defaultPath: "/repo", version: "test", features: ["terminal:search"],
});
const reply = (requestId: string, text: string): TerminalSearchResultMessage => ({
  type: "terminal:search:result", requestId, searchedPanes: 1, skippedPanes: 0, partial: false,
  matches: [{ sessionName: "same", windowId: "@0", paneId: "%0", command: "sh", path: "/repo", line: 1, text, before: "", after: "" }],
});

beforeEach(() => {
  vi.useFakeTimers();
  resetTerminalSearch();
  fixture.machines = [machine("alpha"), machine("beta")];
  fixture.clients.clear();
  fixture.locks = {};
  for (const item of fixture.machines) fixture.clients.set(`inventory:${item.id}`, { status: "connected", send: vi.fn() });
});
afterEach(() => { resetTerminalSearch(); vi.useRealTimers(); });

describe("global terminal search", () => {
  it("uses inventory clients, excludes locked sessions and keeps identical pane IDs on different machines separate", () => {
    fixture.locks.alpha = { private: true };
    searchTerminals("literal [x]", false);
    const requestId = useTerminalSearchStore.getState().requestId!;
    for (const id of ["alpha", "beta"]) {
      const sent = fixture.clients.get(`inventory:${id}`)!.send.mock.calls[0]![0] as ClientMessage;
      expect(sent).toEqual({ type: "terminal:search", requestId, query: "literal [x]", caseSensitive: false, excludeSessions: id === "alpha" ? ["private"] : [] });
      receiveTerminalSearch(id, reply(requestId, id));
    }
    expect(useTerminalSearchStore.getState().machines.map((m) => m.result?.matches[0]?.text)).toEqual(["alpha", "beta"]);
  });

  it("ignores stale replies, duplicate responses and replies after lock", () => {
    searchTerminals("old", false);
    const old = useTerminalSearchStore.getState().requestId!;
    for (const id of ["alpha", "beta"]) receiveTerminalSearch(id, reply(old, "old"));
    searchTerminals("new", true);
    const next = useTerminalSearchStore.getState().requestId!;
    receiveTerminalSearch("alpha", reply(old, "stale"));
    expect(useTerminalSearchStore.getState().machines[0]?.result).toBeUndefined();
    receiveTerminalSearch("alpha", reply(next, "new"));
    receiveTerminalSearch("alpha", reply(next, "duplicate"));
    expect(useTerminalSearchStore.getState().machines[0]?.result?.matches[0]?.text).toBe("new");
    fixture.disconnect();
    receiveTerminalSearch("beta", reply(next, "secret"));
    expect(useTerminalSearchStore.getState()).toMatchObject({ query: "", requestId: null, machines: [] });
  });

  it("reports offline, unsupported and reconnecting machines without sending requests", () => {
    fixture.machines = [{ ...machine("alpha"), online: false }, { ...machine("beta"), features: [] }, machine("gamma")];
    searchTerminals("error", false);
    expect(useTerminalSearchStore.getState().machines.map((m) => m.state)).toEqual(["offline", "unsupported", "error"]);
    for (const client of fixture.clients.values()) expect(client.send).not.toHaveBeenCalled();
  });

  it("prevents overlapping searches and expires pending requests after disconnect or timeout", () => {
    searchTerminals("first", false);
    const requestId = useTerminalSearchStore.getState().requestId!;
    searchTerminals("second", false);
    expect(useTerminalSearchStore.getState().query).toBe("first");
    terminalSearchDisconnected("alpha");
    receiveTerminalSearch("alpha", reply(requestId, "late"));
    vi.advanceTimersByTime(15_000);
    expect(useTerminalSearchStore.getState().machines.map((m) => m.state)).toEqual(["error", "error"]);
    expect(useTerminalSearchStore.getState().machines.every((m) => !m.result)).toBe(true);
  });
});
