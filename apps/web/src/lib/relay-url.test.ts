import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  pairedRelayUrl,
  resolveRelayHttpBase,
  resolveRelayWsUrl,
} from "./relay-url";

const mock = vi.hoisted(() => ({
  session: null as null | { preferredCandidate?: string },
  relay: undefined as string | undefined,
}));
vi.mock("./session-store", () => ({ loadDescriptor: () => mock.session }));
vi.mock("@/env", () => ({
  env: {
    get NEXT_PUBLIC_RELAY_URL() {
      return mock.relay;
    },
  },
}));
beforeEach(() => {
  mock.session = null;
  mock.relay = undefined;
  vi.stubGlobal("window", {
    location: {
      origin: "https://terminal.local",
      host: "terminal.local",
      protocol: "https:",
    },
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("local relay URL", () => {
  it("does not fall back to this machine with another machine's saved token", () => {
    mock.session = { preferredCandidate: "https://foreign.example" };
    expect(pairedRelayUrl()).toBeNull();
    expect(resolveRelayWsUrl()).toBe("");
    expect(resolveRelayHttpBase()).toBe("");
  });
  it("does not fall back when a saved machine has no working candidate", () => {
    mock.session = {};
    expect(resolveRelayWsUrl()).toBe("");
    expect(resolveRelayHttpBase()).toBe("");
  });
  it("uses this origin when no saved machine is active", () => {
    expect(resolveRelayWsUrl()).toBe("wss://terminal.local/_relay");
    expect(resolveRelayHttpBase()).toBe("https://terminal.local");
  });
  it("permits an explicitly configured development relay", () => {
    mock.relay = "wss://relay.local/_relay";
    mock.session = { preferredCandidate: "https://relay.local" };
    expect(resolveRelayWsUrl()).toBe("wss://relay.local/_relay");
    expect(resolveRelayHttpBase()).toBe("https://relay.local");
  });
});
