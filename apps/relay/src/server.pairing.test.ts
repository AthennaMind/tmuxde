import { describe, it, expect, beforeEach } from "vitest";
import { Readable } from "node:stream";
import type http from "node:http";
import {
  handleRelayRequest,
  PAIR_LOCAL_PATH,
  PAIR_SESSION_PATH,
} from "./server.js";
import {
  armLocalPairing,
  resetPairingState,
  setLocalPairingGate,
  isValidSessionToken,
  grantForToken,
  onSessionTokenUsed,
} from "./pairing-local.js";
import { authenticateMessage } from "./auth.js";
import { resetAuthThrottle } from "./auth-throttle.js";
import { config } from "./config.js";

type Captured = {
  status: number;
  headers: Record<string, unknown>;
  body: string;
};

function mockRequest(
  method: string,
  url: string,
  body?: string,
  over: { contentType?: string | null; address?: string } = {},
): http.IncomingMessage {
  const stream = Readable.from(body === undefined ? [] : [Buffer.from(body)]);
  const req = stream as unknown as http.IncomingMessage;
  req.method = method;
  req.url = url;
  const contentType =
    over.contentType === undefined ? "application/json" : over.contentType;
  req.headers = {
    host: "127.0.0.1:14100",
    ...(contentType === null ? {} : { "content-type": contentType }),
  };
  // The throttle is keyed by address, so every request in a test needs one —
  // and tests that want to be throttled separately need different ones.
  req.socket = {
    remoteAddress: over.address ?? "192.168.1.9",
  } as http.IncomingMessage["socket"];
  return req;
}

function mockResponse(): {
  res: http.ServerResponse;
  captured: Captured;
  done: Promise<void>;
} {
  const captured: Captured = { status: 0, headers: {}, body: "" };
  let resolve!: () => void;
  const done = new Promise<void>((r) => (resolve = r));

  const res = {
    setHeader(name: string, value: unknown) {
      captured.headers[name] = value;
    },
    writeHead(status: number, headers?: Record<string, unknown>) {
      captured.status = status;
      Object.assign(captured.headers, headers ?? {});
      return res;
    },
    end(chunk?: string) {
      if (chunk) captured.body += chunk;
      resolve();
      return res;
    },
  } as unknown as http.ServerResponse;

  return { res, captured, done };
}

async function post(
  body?: string,
  over: { contentType?: string | null; address?: string } = {},
): Promise<Captured> {
  const { res, captured, done } = mockResponse();
  const handled = await handleRelayRequest(
    mockRequest("POST", PAIR_LOCAL_PATH, body, over),
    res,
  );
  expect(handled).toBe(true);
  await done;
  return captured;
}

const CODE = "483921";

describe("POST /_pair/local", () => {
  beforeEach(() => {
    resetPairingState();
    resetAuthThrottle();
  });

  it("turns a live nonce into a session token the relay will accept", async () => {
    const { nonce } = armLocalPairing(CODE);

    const captured = await post(JSON.stringify({ nonce }));
    expect(captured.status).toBe(200);

    const { token } = JSON.parse(captured.body) as { token: string };
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    // The whole point: this is NOT the long-lived AUTH_TOKEN.
    expect(token).not.toBe(config.authToken);

    // A LAN pairing is a full grant — it is the machine's owner, standing in
    // front of the machine, scanning the QR it printed.
    const paired = authenticateMessage({ type: "auth", token }, "192.168.1.9");
    expect(paired.authenticated).toBe(true);
    expect(paired.grant?.scope.kind).toBe("all");
  });

  it("never caches the response", async () => {
    const { nonce } = armLocalPairing(CODE);
    const captured = await post(JSON.stringify({ nonce }));
    expect(captured.headers["Cache-Control"]).toBe("no-store");
  });

  it("refuses a nonce that was already spent", async () => {
    const { nonce } = armLocalPairing(CODE);
    expect((await post(JSON.stringify({ nonce }))).status).toBe(200);

    const second = await post(JSON.stringify({ nonce }));
    expect(second.status).toBe(401);
    expect(second.body).not.toContain(nonce);
  });

  it("refuses an unknown nonce", async () => {
    armLocalPairing(CODE);
    expect((await post(JSON.stringify({ nonce: "wrong" }))).status).toBe(401);
  });

  it("refuses everything when no nonce was ever armed (split mode)", async () => {
    expect((await post(JSON.stringify({ nonce: "anything" }))).status).toBe(
      401,
    );
  });

  it("rejects a missing or malformed body", async () => {
    expect((await post()).status).toBe(400);
    expect((await post("not json")).status).toBe(400);
    expect((await post("{}")).status).toBe(400);
    expect((await post(JSON.stringify({ nonce: 42 }))).status).toBe(400);
  });

  it("turns the typed code into a session token too", async () => {
    armLocalPairing(CODE);
    const captured = await post(JSON.stringify({ code: "483 921" }));
    expect(captured.status).toBe(200);
    const { token } = JSON.parse(captured.body) as { token: string };
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(token).not.toBe(config.authToken);
  });

  it("refuses a wrong code without saying it was wrong", async () => {
    armLocalPairing(CODE);
    const captured = await post(JSON.stringify({ code: "000000" }));
    expect(captured.status).toBe(401);
    // No oracle: the same answer a never-armed offer gives.
    expect(captured.body).not.toContain(CODE);
  });

  it("says 403, not 401, when a human refused it", async () => {
    // The difference is the whole message. "Invalid or already used" sends
    // someone who typed the right code hunting for a typo that is not there.
    setLocalPairingGate(async () => false);
    armLocalPairing(CODE);
    const captured = await post(JSON.stringify({ code: CODE }));
    expect(captured.status).toBe(403);
  });

  it("carries the browser's own name to the question, capped", async () => {
    const asked: { label: string; via: string }[] = [];
    setLocalPairingGate(async (req) => {
      asked.push(req);
      return true;
    });
    armLocalPairing(CODE);
    await post(JSON.stringify({ code: CODE, label: "x".repeat(500) }));
    expect(asked[0]!.via).toBe("code");
    expect(asked[0]!.label).toHaveLength(80);
  });

  it("burns the offer after five wrong codes", async () => {
    armLocalPairing(CODE);
    // One address per guess, so this measures the *code's* budget and not the
    // per-address one — which is tested separately, below.
    for (let i = 0; i < 5; i++) {
      expect(
        (
          await post(JSON.stringify({ code: "000000" }), {
            address: `1.1.1.${i}`,
          })
        ).status,
      ).toBe(401);
    }
    expect(
      (await post(JSON.stringify({ code: CODE }), { address: "1.1.2.1" }))
        .status,
    ).toBe(401);
  });

  /*
   * The code's own five-guess budget is not a bound on its own: burning it
   * re-arms a fresh code and the attacker simply carries on. The per-address
   * backoff is what turns a few hours of requests into centuries of them.
   */
  it("locks an address out after five rejections, and holds through a re-arm", async () => {
    armLocalPairing(CODE);
    for (let i = 0; i < 5; i++) {
      await post(JSON.stringify({ code: "000000" }), { address: "10.0.0.7" });
    }
    armLocalPairing(CODE);
    const locked = await post(JSON.stringify({ code: CODE }), {
      address: "10.0.0.7",
    });
    expect(locked.status).toBe(429);
    expect(Number(locked.headers["Retry-After"])).toBeGreaterThan(0);
  });

  it("leaves a different address alone", async () => {
    armLocalPairing(CODE);
    for (let i = 0; i < 6; i++) {
      await post(JSON.stringify({ code: "000000" }), { address: "10.0.0.8" });
    }
    armLocalPairing(CODE);
    expect(
      (await post(JSON.stringify({ code: CODE }), { address: "10.0.0.9" }))
        .status,
    ).toBe(200);
  });

  it("does not bill a refusal against the address", async () => {
    // The credential was right. Billing it would let somebody lock their own
    // laptop out of pairing by pressing "no" twice.
    setLocalPairingGate(async () => false);
    for (let i = 0; i < 6; i++) {
      armLocalPairing(CODE);
      expect(
        (await post(JSON.stringify({ code: CODE }), { address: "10.0.0.6" }))
          .status,
      ).toBe(403);
    }
  });

  it("clears the backoff on a success", async () => {
    armLocalPairing(CODE);
    for (let i = 0; i < 4; i++) {
      await post(JSON.stringify({ code: "000000" }), { address: "10.0.0.5" });
    }
    armLocalPairing(CODE);
    expect(
      (await post(JSON.stringify({ code: CODE }), { address: "10.0.0.5" }))
        .status,
    ).toBe(200);
    armLocalPairing(CODE);
    for (let i = 0; i < 4; i++) {
      expect(
        (
          await post(JSON.stringify({ code: "000000" }), {
            address: "10.0.0.5",
          })
        ).status,
      ).toBe(401);
    }
  });

  /*
   * A JSON content type is not a "simple request", so a cross-origin POST has
   * to preflight and this origin answers no preflight. Without the check, a
   * page on the open internet could spend guesses and burn the code on screen
   * from the browser of anyone sitting on this wifi — it could never read the
   * answer, but it would not need to.
   */
  it("refuses a content type that would skip the browser's preflight", async () => {
    armLocalPairing(CODE);
    for (const contentType of [
      "text/plain",
      "application/x-www-form-urlencoded",
      null,
    ]) {
      const captured = await post(JSON.stringify({ code: CODE }), {
        contentType,
      });
      expect(captured.status).toBe(415);
    }
    // And the offer is untouched by any of it.
    expect((await post(JSON.stringify({ code: CODE }))).status).toBe(200);
  });

  it("ignores parameters on the content type", async () => {
    armLocalPairing(CODE);
    expect(
      (
        await post(JSON.stringify({ code: CODE }), {
          contentType: "application/json; charset=utf-8",
        })
      ).status,
    ).toBe(200);
  });

  it("strips escape sequences out of the name it shows a human", async () => {
    // The label lands beside a security question on somebody's terminal.
    const asked: { label: string }[] = [];
    setLocalPairingGate(async (req) => {
      asked.push(req);
      return true;
    });
    armLocalPairing(CODE);
    await post(JSON.stringify({ code: CODE, label: "\u001b[2AEvil" }));
    // Defanged rather than rejected: a hostile label must not be able to fail
    // a pairing either, or the sanitiser becomes its own denial of service.
    expect(asked[0]!.label).toBe("[2AEvil");
    expect(asked[0]!.label).not.toContain("\u001b");
  });

  it("rejects GET — the nonce must never ride in a query string", async () => {
    const { res, captured, done } = mockResponse();
    await handleRelayRequest(mockRequest("GET", PAIR_LOCAL_PATH), res);
    await done;
    expect(captured.status).toBe(405);
    expect(captured.headers.Allow).toBe("POST");
  });

  it("leaves unrelated routes to fall through to Next", async () => {
    const { res } = mockResponse();
    const handled = await handleRelayRequest(mockRequest("GET", "/login"), res);
    expect(handled).toBe(false);
  });
});

describe("session tokens and the auth throttle together", () => {
  beforeEach(() => {
    resetPairingState();
    resetAuthThrottle();
  });

  const IP = "192.168.1.77";

  it("locks out an address after five bad tokens, then honours a good one", async () => {
    for (let i = 0; i < 4; i++) {
      expect(
        authenticateMessage({ type: "auth", token: "guess" }, IP).authenticated,
      ).toBe(false);
    }
    // Fifth failure trips the backoff…
    const fifth = authenticateMessage({ type: "auth", token: "guess" }, IP);
    expect(fifth.authenticated).toBe(false);
    expect(fifth.retryAfterMs).toBeGreaterThan(0);

    // …and even the *correct* token is refused while it is in force.
    const locked = authenticateMessage(
      { type: "auth", token: config.authToken },
      IP,
    );
    expect(locked.authenticated).toBe(false);
    expect(locked.reason).toMatch(/Too many failed attempts/);

    // A different address is unaffected.
    expect(
      authenticateMessage(
        { type: "auth", token: config.authToken },
        "10.0.0.1",
      ),
    ).toMatchObject({ authenticated: true });
  });

  it("still accepts the long-lived AUTH_TOKEN alongside session tokens", () => {
    expect(
      authenticateMessage({ type: "auth", token: config.authToken }, IP),
    ).toMatchObject({ authenticated: true });
  });

  it("rejects a session token after the pairing state is reset", async () => {
    const { nonce } = armLocalPairing(CODE);
    const { token } = JSON.parse(
      (await post(JSON.stringify({ nonce }))).body,
    ) as {
      token: string;
    };
    expect(authenticateMessage({ type: "auth", token }, IP).authenticated).toBe(
      true,
    );

    resetPairingState();
    resetAuthThrottle();
    expect(authenticateMessage({ type: "auth", token }, IP).authenticated).toBe(
      false,
    );
  });
});

describe("POST /_pair/session — the lifetime it was asked for", () => {
  beforeEach(() => {
    resetPairingState();
    resetAuthThrottle();
  });

  async function register(body: unknown): Promise<Captured> {
    const { res, captured, done } = mockResponse();
    const req = mockRequest("POST", PAIR_SESSION_PATH, JSON.stringify(body));
    req.headers.authorization = `Bearer ${config.authToken}`;
    req.headers["content-type"] = "application/json";
    // This endpoint mints a credential, so it refuses anything that did not
    // arrive over loopback.
    (req as { socket: unknown }).socket = { remoteAddress: "127.0.0.1" };
    expect(await handleRelayRequest(req, res)).toBe(true);
    await done;
    return captured;
  }

  const token = "9".repeat(64);

  it("honours a lifetime it was given", async () => {
    const day = 24 * 60 * 60 * 1000;
    const captured = await register({ token, ttlMs: 90 * day });
    expect(captured.status).toBe(200);
    // Still valid well past the 24 h default this used to fall back to.
    expect(isValidSessionToken(token, Date.now() + 30 * day)).toBe(true);
  });

  it("uses its own default when no lifetime is named", async () => {
    // One token per assertion: a lookup both renews a live token and evicts a
    // dead one, so asking twice about the same one measures the first answer.
    const hour = 60 * 60 * 1000;
    expect((await register({ token })).status).toBe(200);
    expect(isValidSessionToken(token, Date.now() + 23 * hour)).toBe(true);

    const other = "8".repeat(64);
    expect((await register({ token: other })).status).toBe(200);
    expect(isValidSessionToken(other, Date.now() + 25 * hour)).toBe(false);
  });

  /*
   * A peer record on the last instant of its life produces exactly `0`, and
   * this endpoint used to read any non-positive number as "unspecified" and
   * substitute the 24 h default. That fails open — the caller believes it asked
   * for ninety days and got one — and it is the very bug the callers were
   * changed to avoid. Refusing is the honest answer.
   */
  it("refuses a zero lifetime rather than quietly substituting a day", async () => {
    const captured = await register({ token, ttlMs: 0 });
    expect(captured.status).toBe(400);
    expect(isValidSessionToken(token)).toBe(false);
  });

  it("refuses a negative or non-numeric lifetime", async () => {
    expect((await register({ token, ttlMs: -1 })).status).toBe(400);
    expect((await register({ token, ttlMs: "90d" })).status).toBe(400);
    expect((await register({ token, ttlMs: Number.NaN })).status).toBe(400);
    expect(isValidSessionToken(token)).toBe(false);
  });

  it("carries the device id through, so use can be reported", async () => {
    const seen: string[] = [];
    onSessionTokenUsed((id) => seen.push(id));
    await register({ token, ttlMs: 60_000, deviceId: "browser-abc" });
    expect(grantForToken(token)).not.toBeNull();
    expect(seen).toEqual(["browser-abc"]);
  });
});
