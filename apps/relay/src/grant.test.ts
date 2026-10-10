import { describe, expect, it } from "vitest";
import type { GrantRecord } from "@repo/protocol";
import { isGrantActive } from "@repo/protocol";

import {
  FULL_GRANT,
  allowsSession,
  allowsSessionName,
  isFullGrant,
  narrower,
  visibleSessions,
} from "./grant.js";

function grant(over: Partial<GrantRecord> = {}): GrantRecord {
  return {
    ...FULL_GRANT,
    id: "grn_test",
    scope: { kind: "sessions", sessions: [{ id: "$1", name: "work" }] },
    ...over,
  };
}

describe("session matching", () => {
  it("matches on id, not name", () => {
    const g = grant();
    expect(allowsSession(g, { id: "$1", name: "work" })).toBe(true);
    // Same id, different name: the session was renamed. Still theirs.
    expect(allowsSession(g, { id: "$1", name: "renamed" })).toBe(true);
  });

  it("a rename neither widens nor voids the grant", () => {
    // The reason ids are used at all. Under name matching, renaming `work` to
    // something else and creating a new `work` would silently hand the grant
    // to the new session — a privilege-escalation primitive — while the
    // holder's actual session became invisible.
    const g = grant();

    // The granted session, renamed. Still reachable.
    expect(allowsSession(g, { id: "$1", name: "archive" })).toBe(true);
    // A *different* session that has taken the old name. Not reachable.
    expect(allowsSession(g, { id: "$9", name: "work" })).toBe(false);
  });

  it("falls back to name only when the tmux server has restarted", () => {
    // Session ids restart at $0 on a new tmux server, so after a reboot every
    // pinned id is wrong. Failing closed here would kill every share across a
    // restart, which is user-hostile for a tool that runs on servers.
    const pinned = grant({ tmuxServerPid: 100 });

    // Same server: an id miss is a real miss, whatever the name says.
    expect(allowsSession(pinned, { id: "$9", name: "work" }, 100)).toBe(false);
    // Different server: re-pin by name.
    expect(allowsSession(pinned, { id: "$9", name: "work" }, 777)).toBe(true);
    expect(allowsSession(pinned, { id: "$9", name: "other" }, 777)).toBe(false);
  });

  it("does not fall back when either pid is unknown", () => {
    const g = grant({ tmuxServerPid: null });
    expect(allowsSession(g, { id: "$9", name: "work" }, 777)).toBe(false);
    expect(
      allowsSession(grant({ tmuxServerPid: 5 }), { id: "$9", name: "work" }),
    ).toBe(false);
  });

  it("treats an unknown scope kind as empty, never permissive", () => {
    // Only reachable via a hand-edited or forward-versioned grants.json. The
    // failure mode that matters is the one where an unrecognised value reads
    // as "no restrictions".
    const weird = grant({
      scope: { kind: "everything" } as unknown as GrantRecord["scope"],
    });
    expect(allowsSession(weird, { id: "$1", name: "work" })).toBe(false);
    expect(allowsSessionName(weird, "work")).toBe(false);
  });

  it("lets the full grant see everything", () => {
    expect(isFullGrant(FULL_GRANT)).toBe(true);
    expect(allowsSession(FULL_GRANT, { id: "$42", name: "anything" })).toBe(
      true,
    );
    expect(allowsSessionName(FULL_GRANT, "anything")).toBe(true);
  });

  it("filters a session list without dropping the full grant's", () => {
    const sessions = [
      { name: "work", id: "$1" },
      { name: "other", id: "$2" },
    ] as never;
    expect(visibleSessions(grant(), sessions).map((s) => s.name)).toEqual([
      "work",
    ]);
    expect(visibleSessions(FULL_GRANT, sessions)).toHaveLength(2);
  });
});

describe("expiry and revocation", () => {
  it("expires at exactly its deadline", () => {
    const g = grant({ expiresAt: 1_000 });
    expect(isGrantActive(g, 999)).toBe(true);
    expect(isGrantActive(g, 1_000)).toBe(false);
  });

  it("treats revocation as immediate, regardless of expiry", () => {
    expect(isGrantActive(grant({ revokedAt: 1, expiresAt: null }), 0)).toBe(
      false,
    );
  });

  it("never expires when there is no deadline", () => {
    expect(isGrantActive(grant({ expiresAt: null }), 1e15)).toBe(true);
  });
});

describe("narrower", () => {
  const SCOPES: GrantRecord["scope"][] = [
    { kind: "all" },
    { kind: "sessions", sessions: [] },
    { kind: "sessions", sessions: [{ id: "$1", name: "a" }] },
    {
      kind: "sessions",
      sessions: [
        { id: "$1", name: "a" },
        { id: "$2", name: "b" },
      ],
    },
  ];
  const FILES: GrantRecord["files"][] = ["none", "read", "write"];
  const RANK = { none: 0, read: 1, write: 2 };

  /**
   * The property that matters: combining can only ever take away.
   *
   * Exhaustive over the small space rather than randomised — every axis here
   * has three or four values, so "property test" and "every case" are the
   * same thing, and the failure output names the exact pair.
   */
  it("never widens on any axis", () => {
    for (const aScope of SCOPES) {
      for (const bScope of SCOPES) {
        for (const aFiles of FILES) {
          for (const bFiles of FILES) {
            for (const aRo of [true, false]) {
              for (const bRo of [true, false]) {
                const a = grant({
                  scope: aScope,
                  files: aFiles,
                  readOnly: aRo,
                });
                const b = grant({
                  scope: bScope,
                  files: bFiles,
                  readOnly: bRo,
                });
                const out = narrower(a, b);

                expect(RANK[out.files]).toBeLessThanOrEqual(RANK[a.files]);
                expect(RANK[out.files]).toBeLessThanOrEqual(RANK[b.files]);
                if (a.readOnly || b.readOnly) expect(out.readOnly).toBe(true);

                // Anything the result permits, both inputs permitted.
                for (const probe of [
                  { id: "$1", name: "a" },
                  { id: "$2", name: "b" },
                  { id: "$3", name: "c" },
                ]) {
                  if (allowsSession(out, probe)) {
                    expect(allowsSession(a, probe)).toBe(true);
                    expect(allowsSession(b, probe)).toBe(true);
                  }
                }
              }
            }
          }
        }
      }
    }
  });

  it("takes the earlier of two deadlines", () => {
    expect(
      narrower(grant({ expiresAt: 500 }), grant({ expiresAt: 900 })).expiresAt,
    ).toBe(500);
    expect(
      narrower(grant({ expiresAt: null }), grant({ expiresAt: 900 })).expiresAt,
    ).toBe(900);
    expect(
      narrower(grant({ expiresAt: null }), grant({ expiresAt: null }))
        .expiresAt,
    ).toBeNull();
  });
});
