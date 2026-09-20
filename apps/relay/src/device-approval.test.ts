import { describe, it, expect, beforeEach, vi } from "vitest";
import type { WebSocket } from "ws";
import type { GrantRecord, ServerMessage } from "@repo/protocol";

import {
  createConnection,
  getAllConnections,
  removeConnection,
} from "./connection-manager.js";
import { FULL_GRANT } from "./grant.js";
import type { RateLimiter } from "./rate-limiter.js";
import {
  askDeviceApproval,
  noteApproversChanged,
  pendingApprovalFor,
  resetDeviceApproval,
  resolveDeviceApproval,
} from "./device-approval.js";

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

const limiter = {} as RateLimiter;

const REQUEST = {
  sas: "408315",
  deviceLabel: "Chrome on iOS",
  accountEmail: "someone@example.com",
};

function readOnly(): GrantRecord {
  return { ...FULL_GRANT, id: "grn_ro", readOnly: true };
}

function scoped(): GrantRecord {
  return {
    ...FULL_GRANT,
    id: "grn_scoped",
    scope: { kind: "sessions", sessions: [{ id: "$1", name: "work" }] },
  };
}

/** An authenticated connection with the given grant, plus its inbox. */
function connect(grant: GrantRecord = FULL_GRANT, ip = "10.0.0.1") {
  const inbox: ServerMessage[] = [];
  const conn = createConnection(fakeWs(inbox), limiter, ip);
  conn.authenticated = true;
  conn.grant = grant;
  return { conn, inbox };
}

function requests(inbox: ServerMessage[]) {
  return inbox.filter((m) => m.type === "device:approval-request");
}

function resolutions(inbox: ServerMessage[]) {
  return inbox.filter((m) => m.type === "device:approval-resolved");
}

describe("in-app device approval", () => {
  beforeEach(async () => {
    resetDeviceApproval();
    for (const conn of getAllConnections()) await removeConnection(conn);
  });

  it("abstains rather than denying when nobody is connected", async () => {
    // The distinction the whole design rests on. Denying here would mean that
    // having no browser open silently refused every request, instead of
    // handing the question to the TTY prompt.
    await expect(askDeviceApproval(REQUEST)).resolves.toBeNull();
  });

  it("puts the device, the account and the digits in front of a full grant", async () => {
    const { inbox } = connect();
    const answer = askDeviceApproval(REQUEST);

    const [asked] = requests(inbox);
    expect(asked).toMatchObject({
      type: "device:approval-request",
      deviceLabel: "Chrome on iOS",
      accountEmail: "someone@example.com",
      sas: "408315",
    });

    resolveDeviceApproval((asked as { id: string }).id, true);
    await expect(answer).resolves.toBe(true);
  });

  /**
   * A code pairing asks without digits, and the absence has to survive the wire.
   *
   * If `sas` arrived as an empty string the dialog would render the comparison
   * block with nothing in it, and a human would compare nothing to nothing and
   * approve. The field must be genuinely absent, and `via` must say why.
   */
  it("carries no digits at all for a code pairing, and says it is one", async () => {
    const { inbox } = connect();
    const answer = askDeviceApproval({
      deviceLabel: "Safari on iPhone",
      accountEmail: "",
      via: "code",
    });

    const [asked] = requests(inbox);
    expect(asked).toMatchObject({
      via: "code",
      deviceLabel: "Safari on iPhone",
    });
    expect(asked).not.toHaveProperty("sas");

    resolveDeviceApproval((asked as { id: string }).id, false);
    await expect(answer).resolves.toBe(false);
  });

  it("never shows the question to a read-only or scoped share", async () => {
    // Half of the escalation defence; `POLICY["device:approve"]` is the other.
    // A share that could admit a device would grant more than it holds.
    const ro = connect(readOnly(), "10.0.0.2");
    const narrow = connect(scoped(), "10.0.0.3");

    await expect(askDeviceApproval(REQUEST)).resolves.toBeNull();
    expect(requests(ro.inbox)).toEqual([]);
    expect(requests(narrow.inbox)).toEqual([]);
  });

  it("asks every eligible device, and the first answer wins", async () => {
    const a = connect(FULL_GRANT, "10.0.0.1");
    const b = connect(FULL_GRANT, "10.0.0.2");
    const answer = askDeviceApproval(REQUEST);

    const id = (requests(a.inbox)[0] as { id: string }).id;
    expect(requests(b.inbox)).toHaveLength(1);

    expect(resolveDeviceApproval(id, false)).toBe(true);
    await expect(answer).resolves.toBe(false);

    // The loser is told, rather than left showing a decision that can no
    // longer be made.
    expect(resolutions(b.inbox)).toEqual([
      {
        type: "device:approval-resolved",
        id,
        approved: false,
        reason: "decided",
      },
    ]);
  });

  it("refuses a second answer to a question already settled", async () => {
    const { inbox } = connect();
    const answer = askDeviceApproval(REQUEST);
    const id = (requests(inbox)[0] as { id: string }).id;

    expect(resolveDeviceApproval(id, true)).toBe(true);
    // Two phones tapping at once is the normal case. The loser gets a clean
    // "no longer waiting", not a second approval.
    expect(resolveDeviceApproval(id, true)).toBe(false);
    await expect(answer).resolves.toBe(true);
  });

  it("denies on timeout, because silence is not consent", async () => {
    vi.useFakeTimers();
    try {
      const { inbox } = connect();
      const answer = askDeviceApproval(REQUEST, { timeoutMs: 1_000 });
      await vi.advanceTimersByTimeAsync(1_001);
      await expect(answer).resolves.toBe(false);
      expect(resolutions(inbox)[0]).toMatchObject({ reason: "expired" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("abstains, rather than denying, when the last approver disconnects", async () => {
    // Deliberately the opposite of `approve-control.ts`, and the asymmetry is
    // the point: an approver who *opened a window* and left has refused, but a
    // browser that was merely connected never volunteered to answer. Denying
    // for it would let closing a tab veto the machine's own prompt.
    const { conn } = connect();
    const answer = askDeviceApproval(REQUEST);
    await removeConnection(conn);
    noteApproversChanged();
    await expect(answer).resolves.toBeNull();
  });

  it("abstains rather than queueing a second request", async () => {
    connect();
    const first = askDeviceApproval(REQUEST);
    // The browser's half of the SAS exchange expires in 120s, so anything
    // waiting behind a live question would be dead by its turn.
    await expect(askDeviceApproval(REQUEST)).resolves.toBeNull();
    resetDeviceApproval();
    await expect(first).resolves.toBeNull();
  });

  it("replays the live question to a browser that connects mid-flight", async () => {
    const { conn: first } = connect(FULL_GRANT, "10.0.0.1");
    const answer = askDeviceApproval(REQUEST);

    // Opening the app *because* the phone buzzed used to show an ordinary
    // terminal and no way to say yes: the broadcast predated the socket.
    const late = connect(FULL_GRANT, "10.0.0.2");
    const live = pendingApprovalFor(late.conn);
    expect(live).toMatchObject({ sas: "408315" });

    resolveDeviceApproval(live!.id, true);
    await expect(answer).resolves.toBe(true);
    await removeConnection(first);
  });

  it("offers nothing to replay to a share that may not answer", () => {
    const { conn } = connect(FULL_GRANT, "10.0.0.1");
    void askDeviceApproval(REQUEST);
    const narrow = connect(readOnly(), "10.0.0.2");
    expect(pendingApprovalFor(narrow.conn)).toBeNull();
    resetDeviceApproval();
    void conn;
  });

  it("withdraws the question when another channel answers first", async () => {
    const { inbox } = connect();
    const controller = new AbortController();
    const answer = askDeviceApproval(REQUEST, { signal: controller.signal });

    controller.abort();
    // Abstain, not deny: somebody at the machine said something, and this
    // channel has no business overwriting it.
    await expect(answer).resolves.toBeNull();
    expect(resolutions(inbox)[0]).toMatchObject({
      approved: false,
      reason: "withdrawn",
    });
  });
});
