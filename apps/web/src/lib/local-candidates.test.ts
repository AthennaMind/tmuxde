import { afterEach, describe, expect, it, vi } from "vitest";
import { localCandidates } from "./local-candidates";

vi.mock("@/env", () => ({
  env: { NEXT_PUBLIC_RELAY_URL: "ws://localhost:14300" },
}));
afterEach(() => vi.unstubAllGlobals());

describe("local candidate policy", () => {
  it("allows only this origin and explicitly configured relay", () => {
    vi.stubGlobal("window", { location: { origin: "https://terminal.local" } });
    expect(
      localCandidates([
        "https://terminal.local",
        "http://localhost:14300",
        "https://api.mtmux.com",
        "http://192.168.1.5:14100",
      ]),
    ).toEqual(["https://terminal.local", "http://localhost:14300"]);
  });
  it("rejects malformed candidates and embedded credentials", () => {
    vi.stubGlobal("window", { location: { origin: "https://terminal.local" } });
    expect(
      localCandidates([
        "invalid",
        "https://secret@terminal.local",
        "https://terminal.local/proxy",
        "https://terminal.local?host=elsewhere",
      ]),
    ).toEqual([]);
  });
});
