import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveRelayHttpBase, resolveRelayWsUrl } from "./relay-url";

const mock = vi.hoisted(() => ({
  relay: undefined as string | undefined,
}));
vi.mock("@/shared/env", () => ({
  get relayUrl() {
    return mock.relay;
  },
}));
beforeEach(() => {
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

describe("server URL", () => {
  it("binds remote sockets to machine from route", () => {
    vi.stubGlobal("window", {
      location: {
        origin: "https://terminal.local",
        host: "terminal.local",
        protocol: "https:",
        pathname: "/m/alpha/s/dev",
      },
    });
    expect(resolveRelayWsUrl()).toBe("wss://terminal.local/_relay?machine=alpha");
  });

  it("uses this origin by default", () => {
    expect(resolveRelayWsUrl()).toBe("wss://terminal.local/_relay");
    expect(resolveRelayHttpBase()).toBe("https://terminal.local");
  });
  it("uses ws on a plain http origin", () => {
    vi.stubGlobal("window", {
      location: {
        origin: "http://127.0.0.1:24200",
        host: "127.0.0.1:24200",
        protocol: "http:",
      },
    });
    expect(resolveRelayWsUrl()).toBe("ws://127.0.0.1:24200/_relay");
    expect(resolveRelayHttpBase()).toBe("http://127.0.0.1:24200");
  });
  it("uses an explicitly configured development server", () => {
    mock.relay = "wss://relay.local/_relay";
    expect(resolveRelayWsUrl()).toBe("wss://relay.local/_relay");
    expect(resolveRelayHttpBase()).toBe("https://relay.local");
  });
  it("maps a plain ws server to http", () => {
    mock.relay = "ws://127.0.0.1:24200/_relay";
    expect(resolveRelayHttpBase()).toBe("http://127.0.0.1:24200");
  });
});
