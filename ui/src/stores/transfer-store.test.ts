import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientMessage, ServerMessage } from "@/protocol";
import { disconnectAll } from "@/lib/relay-registry";
import { setMachineId } from "@/lib/machine-context";

const clients = vi.hoisted(
  () =>
    [] as {
      options: { url: string; token: string; reconnect: boolean };
      sent: ClientMessage[];
      disconnect: () => void;
      emit: (message: ServerMessage) => void;
    }[],
);
vi.mock("@/lib/file-url", () => ({ getStoredToken: () => "test", downloadFile: vi.fn() }));
vi.mock("@/lib/relay-url", () => ({
  resolveRelayWsUrl: (id: string) => `wss://hub.test/_relay?machine=${id}`,
}));
vi.mock("./machine-store", () => ({
  useMachineStore: {
    getState: () => ({
      machines: [
        { id: "alpha", name: "Alpha" },
        { id: "beta", name: "Beta" },
      ],
    }),
  },
}));
vi.mock("@/lib/ws-client", () => ({
  RelayClient: class {
    status = "disconnected";
    sent: ClientMessage[] = [];
    handlers = new Set<(message: ServerMessage) => void>();
    statuses = new Set<(status: string) => void>();
    constructor(public options: { url: string; token: string; reconnect: boolean }) {
      clients.push(this);
    }
    connect() {
      this.status = "connected";
      this.emit({ type: "auth:success", serverVersion: "test", features: ["file:upload:ack"] });
    }
    disconnect = vi.fn(() => {
      this.status = "disconnected";
      this.statuses.forEach((handler) => handler(this.status));
    });
    send(message: ClientMessage) {
      this.sent.push(message);
    }
    emit(message: ServerMessage) {
      this.handlers.forEach((handler) => handler(message));
    }
    onMessage(handler: (message: ServerMessage) => void) {
      this.handlers.add(handler);
      return () => this.handlers.delete(handler);
    }
    onStatusChange(handler: (status: string) => void) {
      this.statuses.add(handler);
      return () => this.statuses.delete(handler);
    }
  },
}));

import { cancelTransfer, startUploads, useTransferStore } from "./transfer-store";

beforeEach(async () => {
  disconnectAll();
  await new Promise((resolve) => setTimeout(resolve, 0));
  clients.length = 0;
  setMachineId("alpha");
});

describe("transfer lifecycle", () => {
  it("keeps queued uploads on captured machine and cancels without sending final chunks", async () => {
    startUploads(
      [new File(["one"], "one"), new File(["two"], "two"), new File(["three"], "three")],
      "/folder",
    );
    setMachineId("beta");
    await vi.waitFor(() => expect(clients.map((client) => client.sent.length)).toEqual([1, 1]));
    expect(
      clients.every(
        (client) =>
          client.options.url.endsWith("machine=alpha") && client.options.reconnect === false,
      ),
    ).toBe(true);
    const first = useTransferStore.getState().transfers[0]!;
    cancelTransfer(first.id);
    await vi.waitFor(() => expect(clients).toHaveLength(3));
    expect(clients[2]!.options.url).toContain("machine=alpha");
    expect(clients[0]!.disconnect).toHaveBeenCalled();
    expect(clients[0]!.sent).toHaveLength(1);
    disconnectAll();
  });

  it("lock aborts running and queued transfers and clears paths", async () => {
    startUploads(
      [new File(["x"], "one"), new File(["x"], "two"), new File(["x"], "three")],
      "/private",
    );
    await vi.waitFor(() => expect(clients.map((client) => client.sent.length)).toEqual([1, 1]));
    disconnectAll();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(clients).toHaveLength(2);
    expect(clients.every((client) => vi.mocked(client.disconnect).mock.calls.length > 0)).toBe(
      true,
    );
    expect(useTransferStore.getState().transfers).toEqual([]);
  });
});
