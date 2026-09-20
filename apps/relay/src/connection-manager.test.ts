import { describe, it, expect, beforeEach, vi } from "vitest";
import type { WebSocket } from "ws";
import type { GrantRecord, ServerMessage } from "@repo/protocol";

import {
  broadcastToAll,
  broadcastWhere,
  createConnection,
  getAllConnections,
  removeConnection,
  connectionSummary,
  connectionDetails,
  disconnectConnection,
  onConnectionsChanged,
  notifyConnectionsChanged,
  closeRevokedConnections,
} from "./connection-manager.js";
import { FULL_GRANT, allowsSessionName } from "./grant.js";
import type { RateLimiter } from "./rate-limiter.js";

vi.mock("./tmux-clone.js", () => ({
  destroyClone: () => Promise.resolve(),
  isCloneSession: (name: string) => name.startsWith("__mtmux_"),
}));

function fakeWs(inbox: ServerMessage[]): WebSocket {
  return {
    readyState: 1,
    bufferedAmount: 0,
    send: (raw: string) => inbox.push(JSON.parse(raw) as ServerMessage),
    close: () => {},
  } as unknown as WebSocket;
}

/** A socket that records how it was closed, for the revocation sweep. */
function closableWs(closes: { code: number; reason: string }[]): WebSocket {
  return {
    readyState: 1,
    bufferedAmount: 0,
    send: () => {},
    close: (code: number, reason: string) => closes.push({ code, reason }),
  } as unknown as WebSocket;
}

function scopedTo(names: string[]): GrantRecord {
  return {
    ...FULL_GRANT,
    id: `grn_${names.join("_")}`,
    scope: {
      kind: "sessions",
      sessions: names.map((name, i) => ({ id: `$${i + 1}`, name })),
    },
  };
}

const limiter = {} as RateLimiter;

describe("scoped broadcasts", () => {
  beforeEach(async () => {
    for (const conn of getAllConnections()) await removeConnection(conn);
  });

  /**
   * The test the plan singled out, and the reason it exists: this leak is
   * invisible with one browser connected. It only appears when two are, with
   * different scopes, at the same moment — which is exactly the situation
   * `mtmux share` creates and nothing before it did.
   */
  it("delivers a session event to one scope and not the other", async () => {
    const inboxA: ServerMessage[] = [];
    const inboxB: ServerMessage[] = [];

    const a = createConnection(fakeWs(inboxA), limiter, "10.0.0.1");
    a.authenticated = true;
    a.grant = scopedTo(["work"]);

    const b = createConnection(fakeWs(inboxB), limiter, "10.0.0.2");
    b.authenticated = true;
    b.grant = scopedTo(["other"]);

    broadcastWhere((conn) =>
      allowsSessionName(conn.grant, "work")
        ? { type: "session:killed", name: "work" }
        : null,
    );

    expect(inboxA).toEqual([{ type: "session:killed", name: "work" }]);
    // The whole point. B must not learn that a session called "work" exists.
    expect(inboxB).toEqual([]);
  });

  it("skips connections that have not authenticated", () => {
    const inbox: ServerMessage[] = [];
    const conn = createConnection(fakeWs(inbox), limiter, "10.0.0.3");
    conn.authenticated = false;

    broadcastToAll({ type: "session:killed", name: "work" });
    expect(inbox).toEqual([]);
  });

  it("honours the exclusion, so an actor is not told its own news twice", () => {
    const inboxA: ServerMessage[] = [];
    const inboxB: ServerMessage[] = [];
    const a = createConnection(fakeWs(inboxA), limiter, "10.0.0.4");
    a.authenticated = true;
    const b = createConnection(fakeWs(inboxB), limiter, "10.0.0.5");
    b.authenticated = true;

    broadcastToAll({ type: "session:killed", name: "work" }, a.ws);

    expect(inboxA).toEqual([]);
    expect(inboxB).toHaveLength(1);
  });

  it("keeps delivering when one connection's builder throws", () => {
    const inboxA: ServerMessage[] = [];
    const inboxB: ServerMessage[] = [];
    const a = createConnection(fakeWs(inboxA), limiter, "10.0.0.6");
    a.authenticated = true;
    const b = createConnection(fakeWs(inboxB), limiter, "10.0.0.7");
    b.authenticated = true;

    broadcastWhere((conn) => {
      if (conn.id === a.id) throw new Error("builder blew up");
      return { type: "session:killed", name: "work" };
    });

    expect(inboxA).toEqual([]);
    expect(inboxB).toHaveLength(1);
  });

  it("gives a full grant everything a scoped one is denied", () => {
    const inbox: ServerMessage[] = [];
    const conn = createConnection(fakeWs(inbox), limiter, "10.0.0.8");
    conn.authenticated = true;
    conn.grant = FULL_GRANT;

    broadcastWhere((c) =>
      allowsSessionName(c.grant, "anything-at-all")
        ? { type: "session:killed", name: "anything-at-all" }
        : null,
    );

    expect(inbox).toHaveLength(1);
  });
});

/**
 * What `mtmux start` and `mtmux status` display.
 *
 * The CLI used to say nothing at all about who was attached, so a phone that
 * dropped and a phone that was never there looked identical on screen.
 */
describe("connectionSummary", () => {
  beforeEach(async () => {
    for (const conn of getAllConnections()) await removeConnection(conn);
  });

  it("is empty before anything authenticates", () => {
    expect(connectionSummary()).toEqual({ count: 0, devices: [] });
  });

  it("counts authenticated connections only", () => {
    // A socket that has opened but proved nothing is not a device the user
    // admitted. Counting it would make the number twitch at every port scan.
    createConnection(fakeWs([]), limiter, "10.0.0.1");
    const authed = createConnection(fakeWs([]), limiter, "10.0.0.2");
    authed.authenticated = true;
    authed.label = "iPhone · Safari";

    expect(connectionSummary()).toMatchObject({
      count: 1,
      devices: [{ label: "iPhone · Safari", readOnly: false }],
    });
  });

  it("falls back to a neutral label rather than naming nothing", () => {
    const conn = createConnection(fakeWs([]), limiter, "10.0.0.1");
    conn.authenticated = true;

    expect(connectionSummary().devices[0]?.label).toBe("A device");
  });

  it("reports a read-only grant, so a share is visibly a share", () => {
    const conn = createConnection(fakeWs([]), limiter, "10.0.0.1");
    conn.authenticated = true;
    conn.label = "Guest";
    conn.grant = { ...FULL_GRANT, readOnly: true };

    expect(connectionSummary().devices[0]?.readOnly).toBe(true);
  });

  it("carries no address, session or scope across the control boundary", () => {
    const conn = createConnection(fakeWs([]), limiter, "192.168.1.50");
    conn.authenticated = true;
    conn.label = "iPhone";
    conn.attachedSession = "secret-project";

    const serialised = JSON.stringify(connectionSummary());
    expect(serialised).not.toContain("192.168.1.50");
    expect(serialised).not.toContain("secret-project");
  });

  /**
   * The other half of the boundary, asserted so the split cannot quietly
   * collapse back into one type. If someone widens `connectionSummary` the
   * test above fails; if someone narrows `connectionDetails` to match it, the
   * live panel goes blank and this one fails. Both directions are covered.
   */
  it("gives an in-process caller the address, session and scope", () => {
    const conn = createConnection(fakeWs([]), limiter, "192.168.1.50");
    conn.authenticated = true;
    conn.label = "iPhone";
    conn.attachedSession = "secret-project";

    expect(connectionDetails()[0]).toMatchObject({
      id: conn.id,
      label: "iPhone",
      attachedSession: "secret-project",
      remoteAddress: "192.168.1.50",
      scope: { kind: "all" },
    });
  });

  it("names a share's sessions, so a scoped row reads as scoped", () => {
    const conn = createConnection(fakeWs([]), limiter, "10.0.0.1");
    conn.authenticated = true;
    conn.grant = {
      ...FULL_GRANT,
      scope: { kind: "sessions", sessions: [{ id: "$1", name: "work" }] },
    };

    expect(connectionDetails()[0]?.scope).toEqual({
      kind: "sessions",
      sessions: ["work"],
    });
  });

  it("orders oldest first, so the list does not reshuffle on every render", () => {
    const first = createConnection(fakeWs([]), limiter, "10.0.0.1");
    first.authenticated = true;
    first.label = "First";
    first.connectedAt = 1000;
    const second = createConnection(fakeWs([]), limiter, "10.0.0.2");
    second.authenticated = true;
    second.label = "Second";
    second.connectedAt = 2000;

    expect(connectionSummary().devices.map((d) => d.label)).toEqual([
      "First",
      "Second",
    ]);
  });
});

describe("onConnectionsChanged", () => {
  it("notifies subscribers and stops after unsubscribe", () => {
    let fired = 0;
    const off = onConnectionsChanged(() => fired++);
    notifyConnectionsChanged();
    expect(fired).toBe(1);
    off();
    notifyConnectionsChanged();
    expect(fired).toBe(1);
  });

  it("survives a listener that throws", () => {
    // A broken display must never be able to take down a connection.
    const off1 = onConnectionsChanged(() => {
      throw new Error("boom");
    });
    let reached = false;
    const off2 = onConnectionsChanged(() => {
      reached = true;
    });
    expect(() => notifyConnectionsChanged()).not.toThrow();
    expect(reached).toBe(true);
    off1();
    off2();
  });
});

/**
 * `mtmux devices revoke` used to report success while the revoked device kept
 * working: dropping the token from the map only stops the *next*
 * authentication, and a socket already up holds its grant in memory.
 */
describe("closeRevokedConnections", () => {
  beforeEach(async () => {
    for (const conn of getAllConnections()) await removeConnection(conn);
  });

  it("closes exactly the socket whose token was revoked", () => {
    const closesA: { code: number; reason: string }[] = [];
    const closesB: { code: number; reason: string }[] = [];
    const a = createConnection(closableWs(closesA), limiter, "10.0.0.20");
    a.authenticated = true;
    a.tokenId = "tok-a";
    const b = createConnection(closableWs(closesB), limiter, "10.0.0.21");
    b.authenticated = true;
    b.tokenId = "tok-b";

    expect(closeRevokedConnections(["tok-a"])).toBe(1);
    expect(closesA).toEqual([{ code: 1008, reason: "Access revoked" }]);
    expect(closesB).toEqual([]);
  });

  /**
   * The regression that matters. `FULL_GRANT` is one shared record, so a sweep
   * keyed on `grant.id` would have disconnected every device on the machine —
   * including the machine's own token, which has no `tokenId` at all.
   */
  it("leaves the machine's own connection alone", () => {
    const closes: { code: number; reason: string }[] = [];
    const conn = createConnection(closableWs(closes), limiter, "127.0.0.1");
    conn.authenticated = true;
    conn.tokenId = null;

    expect(closeRevokedConnections(["tok-a", "tok-b"])).toBe(0);
    expect(closes).toEqual([]);
  });

  it("does nothing for an empty revocation", () => {
    const closes: { code: number; reason: string }[] = [];
    const conn = createConnection(closableWs(closes), limiter, "10.0.0.22");
    conn.tokenId = "tok-c";
    expect(closeRevokedConnections([])).toBe(0);
    expect(closes).toEqual([]);
  });
});

/**
 * Hanging up, which is the one action the live panel can take on a connection.
 *
 * The distinction it must preserve is temporary vs permanent: this closes a
 * socket and leaves the credential valid, so the browser is free to come back.
 * Revoking is `mtmux devices revoke`, and conflating the two would mean
 * someone reaching for "close this tab" and permanently un-pairing their own
 * phone.
 */
describe("disconnectConnection", () => {
  beforeEach(async () => {
    for (const conn of getAllConnections()) await removeConnection(conn);
  });

  it("closes the socket and drops it from the list", async () => {
    const conn = createConnection(fakeWs([]), limiter, "10.0.0.1");
    conn.authenticated = true;
    conn.label = "iPhone";

    await expect(disconnectConnection(conn.id)).resolves.toBe(true);
    expect(connectionDetails()).toEqual([]);
  });

  it("closes only the socket named, not the device's other tabs", async () => {
    // Two tabs on one phone share a token and a device id. "Close that one"
    // has to mean one of them, which is why the panel keys on connection id.
    const a = createConnection(fakeWs([]), limiter, "10.0.0.1");
    a.authenticated = true;
    a.label = "iPhone";
    a.tokenId = "tok-shared";
    const b = createConnection(fakeWs([]), limiter, "10.0.0.1");
    b.authenticated = true;
    b.label = "iPhone";
    b.tokenId = "tok-shared";

    await disconnectConnection(a.id);
    expect(connectionDetails().map((d) => d.id)).toEqual([b.id]);
  });

  it("reports false for an id that is not connected", async () => {
    // Says so rather than throwing: the panel races the list against the
    // socket closing on its own, and losing that race is ordinary.
    await expect(disconnectConnection("gone")).resolves.toBe(false);
  });
});
