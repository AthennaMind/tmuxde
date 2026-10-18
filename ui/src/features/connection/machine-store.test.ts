import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useMachineStore } from "./machine-store";

beforeEach(() => {
  useMachineStore.setState({ terminals: [], inventory: {}, capture: null });
});

afterEach(() => {
  vi.useRealTimers();
});

it("opens one terminal per machine and session without name collisions", () => {
  const store = useMachineStore.getState();
  store.openTerminal("alpha", "dev");
  store.openTerminal("beta", "dev");
  store.openTerminal("alpha", "dev");
  expect(useMachineStore.getState().terminals).toEqual([
    { machineId: "alpha", sessionName: "dev" },
    { machineId: "beta", sessionName: "dev" },
  ]);
  store.closeTerminal("alpha", "dev");
  expect(useMachineStore.getState().terminals).toEqual([{ machineId: "beta", sessionName: "dev" }]);
});

it("starts the capture deadline when the copy is asked for", () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000);
  useMachineStore.getState().expectCapture("alpha", "%3");
  expect(useMachineStore.getState().capture).toEqual({
    machineId: "alpha",
    paneId: "%3",
    expires: 11_000,
  });
});
