import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ClientMessage, PreviewFrame } from "@/protocol";
const fixture = vi.hoisted(() => ({
  clients: new Map<string, { status: string; send: ReturnType<typeof vi.fn> }>(),
  locks: {} as Record<string, Record<string, true>>,
  disconnect: () => {},
  keysChanged: (_machine: string) => {},
}));
vi.mock("@/lib/lock-store", () => ({ sessionLocks: (id: string) => fixture.locks[id] ?? {} }));
vi.mock("./machine-store", () => ({
  useMachineStore: {
    getState: () => ({
      machines: ["alpha", "beta"].map((id) => ({ id, features: ["terminal:preview"] })),
    }),
  },
}));
vi.mock("@/lib/unlocked", () => ({
  subscribeKeys: (fn: (id: string) => void) => {
    fixture.keysChanged = fn;
  },
}));
vi.mock("@/lib/relay-registry", () => ({
  get: (key: string) => fixture.clients.get(key),
  onDisconnectAll: (fn: () => void) => {
    fixture.disconnect = fn;
  },
}));
import {
  configurePreviews,
  previewConnectionChanged,
  previewKey,
  receiveTerminalPreview,
  resetPreviews,
  syncPreviews,
  useTerminalPreviewStore,
  watchPreview,
} from "./terminal-preview-store";
const releases: (() => void)[] = [];
const frame: PreviewFrame = {
  paneId: "%1",
  cols: 80,
  rows: 24,
  content: "screen",
  unavailable: false,
};
const start = () => configurePreviews({ open: true, hidden: false });
const sent = (machine = "alpha") =>
  fixture.clients
    .get(`inventory:${machine}`)!
    .send.mock.calls.map(([m]) => m as Extract<ClientMessage, { type: "terminal:preview" }>);
const watch = (machine = "alpha", paneId = "%1", session = "work") =>
  releases.push(watchPreview(`${machine}:${paneId}`, machine, [{ session, paneId }]));
const receive = (machine = "alpha", content = "screen") =>
  receiveTerminalPreview(machine, {
    type: "terminal:preview:frame",
    requestId: sent(machine).at(-1)!.requestId,
    frames: [{ ...frame, content }],
  });
beforeEach(() => {
  vi.useFakeTimers();
  resetPreviews();
  fixture.clients.clear();
  fixture.locks = {};
  for (const machine of ["alpha", "beta"])
    fixture.clients.set(`inventory:${machine}`, { status: "connected", send: vi.fn() });
});
afterEach(() => {
  releases.splice(0).forEach((release) => release());
  resetPreviews();
  vi.useRealTimers();
});

it("scopes identical pane IDs to machines and rejects stale or unrequested frames", () => {
  watch();
  watch("beta");
  start();
  receive();
  receive("beta", "other");
  expect(useTerminalPreviewStore.getState().frames[previewKey("alpha", "%1")]?.content).toBe(
    "screen",
  );
  expect(useTerminalPreviewStore.getState().frames[previewKey("beta", "%1")]?.content).toBe(
    "other",
  );
  const old = sent()[0]!.requestId;
  syncPreviews(true);
  receiveTerminalPreview("alpha", {
    type: "terminal:preview:frame",
    requestId: old,
    frames: [{ ...frame, content: "stale" }],
  });
  receiveTerminalPreview("alpha", {
    type: "terminal:preview:frame",
    requestId: sent().at(-1)!.requestId,
    frames: [{ ...frame, paneId: "%99" }],
  });
  expect(Object.keys(useTerminalPreviewStore.getState().frames)).toHaveLength(2);
  expect(useTerminalPreviewStore.getState().frames[previewKey("alpha", "%1")]?.content).toBe(
    "screen",
  );
});
it("streams continuously and renews even after receiving a screen", () => {
  watch();
  start();
  receive();
  const requestId = sent().at(-1)!.requestId;
  syncPreviews(true);
  expect(sent().at(-1)?.requestId).not.toBe(requestId);
  expect(sent().at(-1)?.targets).toEqual([{ session: "work", paneId: "%1" }]);
  expect(sent().every((message) => message.once === false)).toBe(true);
  receive("alpha", "updated screen");
  expect(useTerminalPreviewStore.getState().frames[previewKey("alpha", "%1")]?.content).toBe(
    "updated screen",
  );
});
it("stops hidden and removed cards and clears content on device lock", () => {
  watch();
  start();
  receive();
  configurePreviews({ open: true, hidden: true });
  expect(sent().at(-1)?.targets).toEqual([]);
  start();
  receive();
  releases.pop()!();
  vi.advanceTimersByTime(50);
  expect(sent().at(-1)?.targets).toEqual([]);
  expect(useTerminalPreviewStore.getState().frames).toEqual({});
  watch();
  start();
  receive();
  fixture.disconnect();
  expect(useTerminalPreviewStore.getState().frames).toEqual({});
});
it("clears linked screens when exclusions change, then renews after reconnect", () => {
  watch();
  start();
  receive();
  fixture.locks.alpha = { private: true };
  fixture.keysChanged("alpha");
  expect(useTerminalPreviewStore.getState().frames).toEqual({});
  vi.advanceTimersByTime(50);
  expect(sent().at(-1)?.excludeSessions).toEqual(["private"]);
  fixture.clients.get("inventory:alpha")!.status = "reconnecting";
  previewConnectionChanged("alpha");
  vi.advanceTimersByTime(50);
  const count = sent().length;
  fixture.clients.get("inventory:alpha")!.status = "connected";
  previewConnectionChanged("alpha");
  vi.advanceTimersByTime(50);
  expect(sent()).toHaveLength(count + 1);
});
it("bounds visible requests and excludes locked sessions", () => {
  fixture.locks.alpha = { private: true };
  watch("alpha", "%99", "private");
  for (let i = 0; i < 40; i++) watch("alpha", `%${i}`);
  start();
  expect(sent().at(-1)?.targets).toHaveLength(32);
  expect(
    sent()
      .at(-1)
      ?.targets.some((target) => target.session === "private"),
  ).toBe(false);
});

it("streams hover previews without Overview and stops when hover closes", () => {
  const release = watchPreview("hover", "alpha", [{ session: "work", paneId: "%1" }], true);
  releases.push(release);
  syncPreviews();
  expect(sent().at(-1)?.targets).toEqual([{ session: "work", paneId: "%1" }]);
  receive();
  expect(useTerminalPreviewStore.getState().frames[previewKey("alpha", "%1")]).toEqual(frame);
  release();
  expect(sent().at(-1)?.targets).toEqual([]);
  expect(useTerminalPreviewStore.getState().frames).toEqual({});
});
it("closing Overview keeps hover live and receiving updates", () => {
  watch("alpha", "%2");
  releases.push(watchPreview("hover", "alpha", [{ session: "work", paneId: "%1" }], true));
  start();
  expect(sent().at(-1)?.targets).toHaveLength(2);
  configurePreviews({ open: false, hidden: false });
  expect(sent().at(-1)?.targets).toEqual([{ session: "work", paneId: "%1" }]);
  receive();
  receive("alpha", "still live");
  expect(useTerminalPreviewStore.getState().frames[previewKey("alpha", "%1")]?.content).toBe(
    "still live",
  );
  expect(sent().at(-1)?.once).toBe(false);
});
it("device lock prevents a lingering hover owner from restarting its stream", () => {
  releases.push(watchPreview("hover", "alpha", [{ session: "work", paneId: "%1" }], true));
  syncPreviews();
  receive();
  fixture.disconnect();
  const count = sent().length;
  syncPreviews(true);
  previewConnectionChanged("alpha");
  vi.advanceTimersByTime(50);
  expect(sent()).toHaveLength(count);
  expect(useTerminalPreviewStore.getState().frames).toEqual({});
});

it("reserves room for hover when Overview already watches 32 panes", () => {
  for (let i = 0; i < 32; i++) watch("alpha", `%${i}`);
  start();
  releases.push(watchPreview("hover", "alpha", [{ session: "work", paneId: "%99" }], true));
  syncPreviews();
  expect(sent().at(-1)?.targets).toHaveLength(32);
  expect(sent().at(-1)?.targets[0]?.paneId).toBe("%99");
});
