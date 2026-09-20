import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  APPROVE_DECIDE_PATH,
  APPROVE_STATE_PATH,
  APPROVE_WAIT_PATH,
  createApproveControl,
  type ApproveControl,
} from "./approve-control.js";

/**
 * The loopback channel between `mtmux approve` and the running daemon, driven
 * over a real HTTP server.
 *
 * A real server rather than fake request objects, because two of the things
 * that matter here are properties of the socket and not of the handler: a
 * long-poll that is genuinely parked, and an approver who genuinely goes away
 * mid-request. Both are the difference between a gate and a formality.
 */

const TOKEN = "a".repeat(64);

let control: ApproveControl;
let server: http.Server;
let base: string;

beforeEach(async () => {
  control = createApproveControl({ authToken: TOKEN, offerTimeoutMs: 400 });
  server = http.createServer((req, res) => {
    void control.handle(req, res).then((handled) => {
      if (!handled) {
        res.writeHead(404);
        res.end();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  control.close();
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
});

function call(
  path: string,
  opts: { token?: string | null; body?: unknown; signal?: AbortSignal } = {},
) {
  const token = opts.token === undefined ? TOKEN : opts.token;
  return fetch(`${base}${path}`, {
    method: opts.body === undefined ? "GET" : "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    signal: opts.signal,
  });
}

/** Park a long-poll and hand back the promise, without awaiting it. */
function wait(sessionId: string, minutes = 5, signal?: AbortSignal) {
  return call(APPROVE_WAIT_PATH, {
    body: { sessionId, minutes },
    signal,
  });
}

const settle = () => new Promise((r) => setTimeout(r, 30));

describe("the guard", () => {
  it("refuses a request with no bearer", async () => {
    const res = await call(APPROVE_STATE_PATH, { token: null });
    expect(res.status).toBe(401);
  });

  it("refuses a wrong bearer", async () => {
    const res = await call(APPROVE_STATE_PATH, { token: "b".repeat(64) });
    expect(res.status).toBe(401);
  });

  /**
   * A token of the wrong *length* has to be refused by the same path as one of
   * the right length, or the comparison leaks how long the real one is. This
   * asserts the outcome; the constant-time property is in the implementation.
   */
  it("refuses a bearer of the wrong length without throwing", async () => {
    const res = await call(APPROVE_STATE_PATH, { token: "short" });
    expect(res.status).toBe(401);
  });

  it("ignores paths that are not its own", async () => {
    const res = await call("/health");
    expect(res.status).toBe(404);
  });
});

describe("the window", () => {
  it("reports nothing waiting before anyone asks", async () => {
    const res = await call(APPROVE_STATE_PATH);
    expect(await res.json()).toEqual({ waiting: false, expiresAt: null });
  });

  it("reports an open window once an approver is parked", async () => {
    const controller = new AbortController();
    void wait("s1", 5, controller.signal).catch(() => {});
    await settle();

    const body = (await (await call(APPROVE_STATE_PATH)).json()) as {
      waiting: boolean;
      expiresAt: number;
    };
    expect(body.waiting).toBe(true);
    expect(body.expiresAt).toBeGreaterThan(Date.now());
    controller.abort();
  });

  /**
   * One approver at a time. Two windows would be two humans able to admit the
   * same browser, and only one of them would ever find out.
   */
  it("refuses a second approver with 409", async () => {
    const controller = new AbortController();
    void wait("s1", 5, controller.signal).catch(() => {});
    await settle();

    const res = await wait("s2");
    expect(res.status).toBe(409);
    expect((await res.json()) as { error: string }).toMatchObject({
      error: expect.stringContaining("already open"),
    });
    controller.abort();
  });

  it("lets the same approver re-poll, which is what --keep does", async () => {
    const first = new AbortController();
    void wait("s1", 5, first.signal).catch(() => {});
    await settle();
    first.abort();
    await settle();

    const second = new AbortController();
    const polled = wait("s1", 5, second.signal).catch(() => "aborted");
    await settle();
    expect(control.state().waiting).toBe(true);
    second.abort();
    await polled;
  });
});

describe("offering a request", () => {
  const REQUEST = {
    sas: "482173",
    deviceLabel: "Chrome on macOS",
    accountEmail: "dp@example.com",
  };

  /**
   * The distinction the whole three-way branch in `onAccessRequest` rests on:
   * null means "nobody is waiting, go and use the TTY prompt", and it must not
   * be confusable with a refusal.
   */
  it("returns null when nobody is waiting", async () => {
    expect(await control.offer(REQUEST)).toBeNull();
  });

  it("hands a parked poll the request, and returns the decision", async () => {
    const controller = new AbortController();
    const polled = wait("s1", 5, controller.signal);
    await settle();

    const decision = control.offer(REQUEST);
    const body = (await (await polled).json()) as {
      type: string;
      id: string;
      sas: string;
      deviceLabel: string;
    };
    expect(body.type).toBe("request");
    expect(body.sas).toBe("482173");
    expect(body.deviceLabel).toBe("Chrome on macOS");

    await call(APPROVE_DECIDE_PATH, {
      body: { sessionId: "s1", id: body.id, approved: true },
    });
    expect(await decision).toBe(true);
  });

  it("delivers a request that arrived between polls", async () => {
    const first = new AbortController();
    void wait("s1", 5, first.signal).catch(() => {});
    await settle();
    first.abort();
    await settle();

    // Nothing is parked right now. The offer must survive until the re-poll,
    // or `--keep` would silently drop every request landing in the gap.
    const decision = control.offer(REQUEST);
    await settle();

    const body = (await (await wait("s1")).json()) as {
      type: string;
      id: string;
    };
    expect(body.type).toBe("request");
    await call(APPROVE_DECIDE_PATH, {
      body: { sessionId: "s1", id: body.id, approved: false },
    });
    expect(await decision).toBe(false);
  });

  it("treats anything that is not an explicit true as a refusal", async () => {
    const controller = new AbortController();
    const polled = wait("s1", 5, controller.signal);
    await settle();
    const decision = control.offer(REQUEST);
    const body = (await (await polled).json()) as { id: string };

    await call(APPROVE_DECIDE_PATH, {
      body: { sessionId: "s1", id: body.id, approved: "yes" },
    });
    expect(await decision).toBe(false);
  });

  it("times out as a refusal rather than hanging", async () => {
    const controller = new AbortController();
    void wait("s1", 5, controller.signal).catch(() => {});
    await settle();

    // offerTimeoutMs is 400 in these tests.
    expect(await control.offer(REQUEST)).toBe(false);
    controller.abort();
  });

  /**
   * Walking away is a no. This is the same rule that makes `no-tty` deny
   * instead of wait: nobody answering is not consent.
   */
  it("counts an approver disconnecting as a refusal, never an approval", async () => {
    const controller = new AbortController();
    void wait("s1", 5, controller.signal).catch(() => {});
    await settle();

    const decision = control.offer(REQUEST);
    await settle();
    controller.abort();

    expect(await decision).toBe(false);
  });

  it("refuses a second request while one is in front of a human", async () => {
    const controller = new AbortController();
    void wait("s1", 5, controller.signal).catch(() => {});
    await settle();

    const first = control.offer(REQUEST);
    await settle();
    expect(await control.offer(REQUEST)).toBe(false);

    controller.abort();
    expect(await first).toBe(false);
  });

  it("frees the slot when another channel answers first", async () => {
    // The in-app dialog and this window are raced (`decideAccess`), and the
    // loser has to let go. Without this the answered question kept the
    // one-at-a-time slot for the full offer timeout, so the *next* device to
    // ask was refused outright by a question already decided elsewhere.
    const windowCtl = new AbortController();
    void wait("s1", 5, windowCtl.signal).catch(() => {});
    await settle();

    const raced = new AbortController();
    const abandoned = control.offer(REQUEST, { signal: raced.signal });
    await settle();
    raced.abort();
    expect(await abandoned).toBe(false);

    // The slot is free: a fresh request is taken rather than refused.
    const next = control.offer(REQUEST);
    await settle();
    expect(await Promise.race([next, Promise.resolve("pending")])).toBe(
      "pending",
    );

    windowCtl.abort();
    expect(await next).toBe(false);
  });

  it("refuses a decision from a session that does not hold the window", async () => {
    const controller = new AbortController();
    const polled = wait("s1", 5, controller.signal);
    await settle();
    const decision = control.offer(REQUEST);
    const body = (await (await polled).json()) as { id: string };

    const res = await call(APPROVE_DECIDE_PATH, {
      body: { sessionId: "impostor", id: body.id, approved: true },
    });
    expect(res.status).toBe(409);

    controller.abort();
    expect(await decision).toBe(false);
  });

  it("stops offering once the window is closed", async () => {
    const controller = new AbortController();
    void wait("s1", 5, controller.signal).catch(() => {});
    await settle();
    control.close();
    await settle();

    expect(await control.offer(REQUEST)).toBeNull();
    controller.abort();
  });

  describe("parking, for a machine with no TTY", () => {
    it("holds a request with nobody polling, and hands it over on arrival", async () => {
      // The round trip that had no coverage at all: request → parked → an
      // approver arrives late → SAS → approve → paired.
      const decision = control.offer(REQUEST, { park: true });
      await settle();

      const controller = new AbortController();
      const polled = wait("s1", 5, controller.signal);
      const body = (await (await polled).json()) as {
        id: string;
        sas: string;
      };
      // The digits the human compares are the ones the request carried.
      expect(body.sas).toBe(REQUEST.sas);

      const res = await call(APPROVE_DECIDE_PATH, {
        body: { sessionId: "s1", id: body.id, approved: true },
      });
      expect(res.status).toBe(200);
      expect(await decision).toBe(true);
      controller.abort();
    });

    it("denies rather than waits when the offer window runs out", async () => {
      // Parking changes how long the question stands, never the answer to
      // silence. Nobody ever polls here.
      const decision = control.offer(REQUEST, { park: true });
      // The harness builds the control with a 400ms offer timeout.
      await new Promise((r) => setTimeout(r, 500));
      expect(await decision).toBe(false);
    });

    it("still returns null without park, so the TTY prompt is reached", async () => {
      // The distinction the whole design rests on: "nobody is waiting" is not
      // a refusal, and collapsing them would stop `mtmux start` prompting in
      // its own terminal.
      expect(await control.offer(REQUEST)).toBeNull();
    });

    it("refuses a second parked request rather than queueing it", async () => {
      const first = control.offer(REQUEST, { park: true });
      expect(await control.offer(REQUEST, { park: true })).toBe(false);
      await new Promise((r) => setTimeout(r, 500));
      expect(await first).toBe(false);
    });
  });
});
