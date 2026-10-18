import { beforeEach, expect, it } from "vitest";
import { useMachineStore } from "./machine-store";

beforeEach(() => {
  useMachineStore.setState({ terminals: [], inventory: {} });
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
  expect(useMachineStore.getState().terminals).toEqual([
    { machineId: "beta", sessionName: "dev" },
  ]);
});
