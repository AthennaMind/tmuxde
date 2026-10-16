import { describe, expect, it } from "vitest";
import type { ClientMessage } from "./client-messages";
import type { ServerMessage } from "./server-messages";
import { ServerMessage as ServerMessageSchema } from "./server-messages";
import {
  deserializeClientMessage,
  deserializeServerMessage,
  serialize,
  tryDeserializeClientMessage,
  tryDeserializeServerMessage,
} from "./codec";

// Representative ClientMessage variants exercising the wire contract.
const clientMessages: ClientMessage[] = [
  { type: "auth", token: "secret-token" },
  { type: "ping", timestamp: 1_700_000_000 },
  { type: "terminal:input", data: "ls -la\r" },
  { type: "terminal:resize", size: { cols: 120, rows: 40 } },
  { type: "session:list" },
  { type: "session:create", name: "dev", cwd: "/home/user", command: "bash" },
  { type: "session:create" }, // all-optional fields omitted
  {
    type: "session:attach",
    name: "dev",
    size: { cols: 80, rows: 24 },
    capture: true,
  },
  { type: "session:kill", name: "dev" },
  { type: "file:list", path: "/home/user/project" },
  { type: "file:read", path: "/home/user/project/README.md" },
  { type: "file:write", path: "/home/user/project/a.txt", content: "hello" },
  {
    type: "file:upload",
    path: "/home/user/blob.bin",
    content: "aGVsbG8=",
    final: true,
  },
  { type: "command:send", command: "npm test" },
  { type: "pane:resize", id: "%1", direction: "R", amount: 5 },
  { type: "pane:swap", id: "%1", direction: "D" },
  { type: "pane:swap", id: "%1", target: "%4" },
  { type: "pane:join", id: "%1", windowId: "@2", direction: "v" },
  { type: "pane:break", id: "%1" },
  { type: "window:layout", preset: "tiled" },
  { type: "dictation:start", id: "d1" },
  { type: "dictation:audio", id: "d1", pcm: "AAABAP//" },
  { type: "dictation:stop", id: "d1" },
  { type: "dictation:cancel", id: "d1" },
];

// Representative ServerMessage variants exercising the wire contract.
const serverMessages: ServerMessage[] = [
  { type: "auth:success", serverVersion: "1.2.3" },
  { type: "auth:failure", reason: "bad token" },
  { type: "pong", timestamp: 1_700_000_000 },
  { type: "error", code: "EPERM", message: "not allowed" },
  // server:info WITHOUT the optional defaultPath
  { type: "server:info", hostname: "box", platform: "linux", uptime: 12345 },
  // server:info WITH the new optional defaultPath
  {
    type: "server:info",
    hostname: "box",
    platform: "linux",
    uptime: 12345,
    defaultPath: "/home/user",
  },
  { type: "terminal:output", data: "[32mok[0m\r\n" },
  {
    type: "session:list",
    sessions: [
      {
        name: "dev",
        id: "$0",
        windows: 2,
        attached: true,
        created: "2026-01-01T00:00:00Z",
        activity: "2026-01-01T00:05:00Z",
      },
    ],
  },
  {
    type: "file:list",
    path: "/home/user",
    entries: [
      {
        name: "README.md",
        path: "/home/user/README.md",
        type: "file",
        size: 42,
        modified: "2026-01-01T00:00:00Z",
      },
    ],
  },
  {
    type: "file:op:result",
    op: "delete",
    path: "/home/user/gone.txt",
    success: true,
  },
  { type: "dictation:ready", id: "d1" },
  { type: "dictation:text", id: "d1", text: "Пусни тестовете" },
  { type: "dictation:done", id: "d1" },
  { type: "dictation:error", id: "d1", code: "BUSY", message: "busy" },
];

describe("codec round-trip", () => {
  it.each(clientMessages.map((m, i) => [`${m.type}#${i}`, m] as const))(
    "round-trips ClientMessage %s",
    (_type, msg) => {
      const wire = serialize(msg);
      expect(typeof wire).toBe("string");
      const decoded = deserializeClientMessage(wire);
      expect(decoded).toEqual(msg);
    },
  );

  it.each(serverMessages.map((m, i) => [`${m.type}#${i}`, m] as const))(
    "round-trips ServerMessage %s",
    (_label, msg) => {
      const wire = serialize(msg);
      expect(typeof wire).toBe("string");
      const decoded = deserializeServerMessage(wire);
      expect(decoded).toEqual(msg);
    },
  );

  it("preserves the optional server:info defaultPath field", () => {
    const msg: ServerMessage = {
      type: "server:info",
      hostname: "box",
      platform: "linux",
      uptime: 1,
      defaultPath: "/srv/data",
    };
    const decoded = deserializeServerMessage(serialize(msg));
    expect(decoded).toMatchObject({ defaultPath: "/srv/data" });
  });
});

describe("deserialize rejects malformed input", () => {
  it("throws on invalid JSON", () => {
    expect(() => deserializeClientMessage("{not json")).toThrow();
    expect(() => deserializeServerMessage("{not json")).toThrow();
  });

  it("throws on an unknown discriminant type", () => {
    expect(() =>
      deserializeClientMessage(JSON.stringify({ type: "does:not:exist" })),
    ).toThrow();
    expect(() =>
      deserializeServerMessage(JSON.stringify({ type: "does:not:exist" })),
    ).toThrow();
  });

  it("throws when required fields are missing", () => {
    // auth requires token
    expect(() =>
      deserializeClientMessage(JSON.stringify({ type: "auth" })),
    ).toThrow();
    // error requires code + message
    expect(() =>
      deserializeServerMessage(JSON.stringify({ type: "error", code: "X" })),
    ).toThrow();
  });

  it("takes exactly one of direction or target on pane:swap", () => {
    const swap = (extra: object) =>
      tryDeserializeClientMessage(
        JSON.stringify({ type: "pane:swap", id: "%1", ...extra }),
      ).ok;
    expect(swap({ direction: "U" })).toBe(true);
    expect(swap({ target: "%2" })).toBe(true);
    expect(swap({})).toBe(false);
    expect(swap({ direction: "U", target: "%2" })).toBe(false);
  });

  it("throws when a field has the wrong type", () => {
    // timestamp must be a number
    expect(() =>
      deserializeClientMessage(
        JSON.stringify({ type: "ping", timestamp: "soon" }),
      ),
    ).toThrow();
    // terminal:resize size out of range
    expect(() =>
      deserializeClientMessage(
        JSON.stringify({
          type: "terminal:resize",
          size: { cols: 0, rows: 24 },
        }),
      ),
    ).toThrow();
  });
});

describe("tryDeserialize returns a discriminated result instead of throwing", () => {
  it("returns ok:true with the parsed message on valid input", () => {
    const res = tryDeserializeClientMessage(
      serialize({ type: "terminal:input", data: "x" }),
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.message).toEqual({ type: "terminal:input", data: "x" });
    }
  });

  it("returns ok:false with an error string on invalid input", () => {
    const clientRes = tryDeserializeClientMessage("{bad");
    expect(clientRes.ok).toBe(false);
    if (!clientRes.ok) {
      expect(typeof clientRes.error).toBe("string");
      expect(clientRes.error.length).toBeGreaterThan(0);
    }

    const serverRes = tryDeserializeServerMessage(
      JSON.stringify({ type: "auth:success" }),
    );
    expect(serverRes.ok).toBe(false);
    if (!serverRes.ok) {
      expect(typeof serverRes.error).toBe("string");
    }
  });
});

describe("auth:success capabilities", () => {
  const base = {
    type: "auth:success" as const,
    serverVersion: "1.0.0",
  };

  it("accepts a scope kind it has never heard of", () => {
    // The whole point of loosening `scope` from an enum. The web app ships
    // ahead of the CLI on every user's machine, so a relay introducing a new
    // scope kind would otherwise hard-fail the parse of the message that says
    // the connection is up — and the field is advisory, enforced server-side
    // regardless of what the client makes of it.
    const parsed = ServerMessageSchema.safeParse({
      ...base,
      capabilities: { readOnly: true, files: "none", scope: "future-kind" },
    });
    expect(parsed.success).toBe(true);
  });

  it("still rejects a scope that is not a string at all", () => {
    expect(
      ServerMessageSchema.safeParse({
        ...base,
        capabilities: { readOnly: false, files: "write", scope: 7 },
      }).success,
    ).toBe(false);
  });

  it("keeps files as a closed set", () => {
    // Unlike `scope`, this one drives a real UI decision — whether to render a
    // file tree at all — and there is no forward value to tolerate.
    expect(
      ServerMessageSchema.safeParse({
        ...base,
        capabilities: { readOnly: false, files: "everything", scope: "all" },
      }).success,
    ).toBe(false);
  });

  it("treats absent capabilities as unrestricted, which an older relay is", () => {
    expect(ServerMessageSchema.safeParse(base).success).toBe(true);
  });
});

describe("dictation messages", () => {
  it("refuses audio that is not base64", () => {
    const result = tryDeserializeClientMessage(
      JSON.stringify({ type: "dictation:audio", id: "d1", pcm: "not base64!" }),
    );
    expect(result.ok).toBe(false);
  });

  it("refuses an audio frame far larger than any real one", () => {
    const result = tryDeserializeClientMessage(
      JSON.stringify({ type: "dictation:audio", id: "d1", pcm: "A".repeat(65 * 1024) }),
    );
    expect(result.ok).toBe(false);
  });

  it("refuses an empty or oversized id", () => {
    for (const id of ["", "x".repeat(65)]) {
      const result = tryDeserializeClientMessage(
        JSON.stringify({ type: "dictation:start", id }),
      );
      expect(result.ok).toBe(false);
    }
  });
});
