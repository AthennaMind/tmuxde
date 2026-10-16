import { afterEach, describe, expect, it, vi } from "vitest";
import { machineBasePath, machineId, machineStorageKey } from "./machine-context";

afterEach(() => vi.unstubAllGlobals());

describe("machine context", () => {
  it("keeps existing local sessions and storage compatible", () => {
    vi.stubGlobal("window", { location: { pathname: "/s/dev" } });
    expect(machineId()).toBe("local");
    expect(machineBasePath()).toBe("");
    expect(machineStorageKey("tabs")).toBe("tabs");
  });

  it("separates identical session names and paths by machine", () => {
    vi.stubGlobal("window", { location: { pathname: "/m/alpha/s/dev" } });
    const first = machineStorageKey("tabs");
    expect(machineId()).toBe("alpha");
    expect(machineBasePath()).toBe("/m/alpha");
    vi.stubGlobal("window", { location: { pathname: "/m/beta/s/dev" } });
    expect(machineStorageKey("tabs")).not.toBe(first);
  });
});
