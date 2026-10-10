import { describe, expect, it } from "vitest";
import { ClientMessage } from "./client-messages";
import { ServerMessage } from "./server-messages";
import { RepoResult } from "./repository";

describe("repository messages", () => {
  it("requires correlation and pane IDs on every request", () => {
    const request = { type: "repo:request", action: "context" };
    expect(ClientMessage.safeParse(request).success).toBe(false);
    expect(
      ClientMessage.safeParse({ ...request, id: "%1", requestId: "context-1" })
        .success,
    ).toBe(true);
    expect(
      ClientMessage.safeParse({ ...request, id: "%1", requestId: "" }).success,
    ).toBe(false);
  });

  it("rejects unsupported actions and diff scopes", () => {
    const request = {
      type: "repo:request",
      id: "%1",
      requestId: "request-1",
      action: "diff",
    };
    expect(
      ClientMessage.safeParse({ ...request, action: "commit" }).success,
    ).toBe(false);
    expect(
      ClientMessage.safeParse({ ...request, scope: "history" }).success,
    ).toBe(false);
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
});
