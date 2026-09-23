import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Readable } from "node:stream";
import type http from "node:http";
import { handleRelayRequest } from "./server.js";
import { resetPairingState, issueSessionToken } from "./pairing-local.js";
import {
  setConnectionGate,
  type ConnectionRequest,
} from "./connection-gate.js";
import { FULL_GRANT } from "./grant.js";
import { config } from "./config.js";

/**
 * The relay's two byte-serving HTTP routes, and the question they never asked.
 *
 * `/file` and `/recording` authenticated a bearer token and then served from
 * the machine's disk. The websocket carrying the very same token put a yes/no
 * on the owner's screen; these did not — so the shortest way past the whole
 * approval model was to stop using the terminal and start using the file
 * endpoint. "Every connection is approved" is either true of every route or it
 * is marketing.
 */

function mockRequest(
  url: string,
  over: { token?: string | null; address?: string; userAgent?: string } = {},
): http.IncomingMessage {
  const req = Readable.from([]) as unknown as http.IncomingMessage;
  req.method = "GET";
  req.url = url;
  req.headers = {
    host: "127.0.0.1:14100",
    ...(over.token === null
      ? {}
      : { authorization: `Bearer ${over.token ?? config.authToken}` }),
    ...(over.userAgent ? { "user-agent": over.userAgent } : {}),
  };
  req.socket = {
    remoteAddress: over.address ?? "192.168.1.9",
  } as http.IncomingMessage["socket"];
  return req;
}

function mockResponse(): {
  res: http.ServerResponse;
  captured: { status: number; body: string };
  done: Promise<void>;
} {
  const captured = { status: 0, body: "" };
  let resolve!: () => void;
  const done = new Promise<void>((r) => (resolve = r));
  const res = {
    setHeader() {},
    writeHead(status: number) {
      captured.status = status;
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

async function get(
  url: string,
  over: Parameters<typeof mockRequest>[1] = {},
): Promise<{ status: number; body: string }> {
  const { res, captured, done } = mockResponse();
  const handled = await handleRelayRequest(mockRequest(url, over), res);
  expect(handled).toBe(true);
  await done;
  return captured;
}

const FILE_URL = `/file?path=${encodeURIComponent("/etc/hostname")}`;
const RECORDING_URL = "/recording?id=abc";

describe("the connection gate covers the HTTP routes too", () => {
  beforeEach(() => {
    resetPairingState();
    setConnectionGate(null);
  });
  afterEach(() => setConnectionGate(null));

  it("refuses a file download the gate says no to", async () => {
    setConnectionGate(async () => false);
    const captured = await get(FILE_URL);
    // 403 and not 401: the credential was fine. Re-presenting it is not the
    // way back in.
    expect(captured.status).toBe(403);
    expect(captured.body).toBe("Not approved on the machine");
  });

  it("refuses a recording download the gate says no to", async () => {
    setConnectionGate(async () => false);
    const captured = await get(RECORDING_URL);
    expect(captured.status).toBe(403);
  });

  it("treats a gate that throws as a refusal, here as everywhere", async () => {
    setConnectionGate(async () => {
      throw new Error("the panel has gone");
    });
    expect((await get(FILE_URL)).status).toBe(403);
  });

  it("still answers 401 for a bad token, without asking anybody", async () => {
    // Order matters: a wrong credential must never raise a question on the
    // owner's screen, or the prompt becomes a way to ring their doorbell.
    const asked: ConnectionRequest[] = [];
    setConnectionGate(async (req) => {
      asked.push(req as ConnectionRequest);
      return true;
    });
    expect((await get(FILE_URL, { token: "0".repeat(64) })).status).toBe(401);
    expect((await get(FILE_URL, { token: null })).status).toBe(401);
    expect(asked).toEqual([]);
  });

  it("tells the gate which device is asking, and from where", async () => {
    const asked: Array<{ deviceId: string | null; transport: string }> = [];
    setConnectionGate(async (req) => {
      asked.push({ deviceId: req.deviceId, transport: req.transport });
      return false;
    });
    const { token } = issueSessionToken(
      60_000,
      Date.now(),
      FULL_GRANT,
      "iPhone",
      "browser-abc",
    );
    await get(FILE_URL, { token, address: "10.0.0.4" });
    expect(asked).toEqual([{ deviceId: "browser-abc", transport: "lan" }]);
  });

  it("lets an approved request through to the ordinary checks", async () => {
    setConnectionGate(async () => true);
    // Not 403-from-the-gate: this is `isPathAllowed` doing its own job, which
    // is the proof the request got past the door.
    const captured = await get(
      `/file?path=${encodeURIComponent("/etc/shadow")}`,
    );
    expect(captured.status).toBe(403);
    expect(captured.body).toBe("Access denied");
  });
});
