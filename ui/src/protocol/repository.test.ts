import { describe, expect, it } from "vitest";
import { ClientMessage } from "./client-messages";
import { ServerMessage } from "./server-messages";
import { RepoResult } from "./repository";

describe("repository messages", () => {
  it("requires correlation and pane IDs on every request", () => {
    const request = { type: "repo:request", action: "context" };
    expect(ClientMessage.safeParse(request).success).toBe(false);
    expect(ClientMessage.safeParse({ ...request, id: "%1", requestId: "context-1" }).success).toBe(
      true,
    );
    expect(ClientMessage.safeParse({ ...request, id: "%1", requestId: "" }).success).toBe(false);
  });

  it("rejects unsupported actions and diff scopes", () => {
    const request = {
      type: "repo:request",
      id: "%1",
      requestId: "request-1",
      action: "diff",
    };
    expect(ClientMessage.safeParse({ ...request, action: "commit" }).success).toBe(false);
    expect(ClientMessage.safeParse({ ...request, scope: "history" }).success).toBe(false);
    expect(
      ClientMessage.safeParse({
        ...request,
        scope: "staged",
        file: "name\n.txt",
      }).success,
    ).toBe(true);
  });

  it("accepts correlated errors and status entries without losing spaces", () => {
    expect(
      ServerMessage.parse({
        type: "repo:result",
        requestId: "request-1",
        result: { kind: "error", message: "Access denied" },
      }),
    ).toMatchObject({ requestId: "request-1" });
    const result = RepoResult.parse({
      kind: "status",
      root: "/repo",
      branch: null,
      entries: [{ path: "deleted", index: " ", worktree: "D" }],
      truncated: false,
    });
    expect(result).toMatchObject({ entries: [{ index: " " }] });
  });

  it("bounds history paging and accepts only hex commit ids", () => {
    const request = {
      type: "repo:request",
      id: "%1",
      requestId: "request-1",
    };
    const ok = (extra: object) => ClientMessage.safeParse({ ...request, ...extra }).success;
    expect(ok({ action: "log" })).toBe(true);
    expect(ok({ action: "log", skip: 100 })).toBe(true);
    expect(ok({ action: "log", skip: -1 })).toBe(false);
    expect(ok({ action: "log", skip: 1.5 })).toBe(false);
    expect(ok({ action: "show", commit: "a1b2c3d" })).toBe(true);
    expect(ok({ action: "show", commit: "a".repeat(40) })).toBe(true);
    expect(ok({ action: "show", commit: "a1b2c3" })).toBe(false);
    expect(ok({ action: "show", commit: "HEAD" })).toBe(false);
    expect(ok({ action: "show", commit: "--output=x" })).toBe(false);
    expect(ok({ action: "show", commit: "A1B2C3D" })).toBe(false);
  });

  it("parses log pages and commit patches", () => {
    const commit = {
      hash: "a".repeat(40),
      parents: [],
      author: "Test",
      date: "2026-10-11T12:00:00+00:00",
      subject: "First",
      refs: ["HEAD -> main"],
    };
    expect(
      RepoResult.parse({
        kind: "log",
        root: "/repo",
        branch: "main",
        skip: 0,
        commits: [commit],
        more: false,
      }),
    ).toMatchObject({ commits: [{ subject: "First" }] });
    expect(
      RepoResult.parse({
        kind: "show",
        root: "/repo",
        commit: {
          ...commit,
          email: "test@example.invalid",
          committer: "Test",
          committerDate: commit.date,
          body: "",
        },
        files: [
          {
            path: "image.png",
            status: "A",
            additions: null,
            deletions: null,
            binary: true,
            patch: "",
          },
        ],
        hidden: 0,
        truncated: false,
      }),
    ).toMatchObject({ files: [{ binary: true }] });
  });
});
