import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RepoResult } from "@/protocol";
import { currentChangeFiles, loadCurrentChanges } from "./current-changes";
import { repositoryRequest, type RepositoryClient } from "./repository-request";

vi.mock("./repository-request", () => ({ repositoryRequest: vi.fn() }));
const request = vi.mocked(repositoryRequest);
const client = { status: "connected" } as RepositoryClient;
const entry = (path: string, index = " ", worktree = "M") => ({ path, index, worktree });
const status = (entries: ReturnType<typeof entry>[]): Extract<RepoResult, { kind: "status" }> => ({
  kind: "status",
  root: "/repo",
  branch: "main",
  entries,
  truncated: false,
});
const patch = "diff --git a/file b/file\n--- a/file\n+++ b/file\n@@ -1 +1 @@\n-old\n+new\n";
const diff = (content = patch, binary = false): Extract<RepoResult, { kind: "diff" }> => ({
  kind: "diff",
  path: "file",
  scope: "unstaged",
  content,
  binary,
  truncated: false,
});
const load = (signal = new AbortController().signal) =>
  loadCurrentChanges(client, "%1", "/repo", signal);

beforeEach(() => {
  request.mockReset();
});

describe("current changes", () => {
  it("keeps partially staged files in both scopes and untracked files once", () => {
    expect(
      currentChangeFiles([
        entry("both.ts", "M", "M"),
        entry("new.md", "?", "?"),
        entry("removed", "D", " "),
        entry("ignored", "!", "!"),
        entry("conflict", "U", "U"),
      ]).map(({ path, scope, status }) => [path, scope, status]),
    ).toEqual([
      ["both.ts", "unstaged", "M"],
      ["conflict", "unstaged", "U"],
      ["both.ts", "staged", "M"],
      ["removed", "staged", "D"],
      ["conflict", "staged", "U"],
      ["new.md", "untracked", "?"],
    ]);
  });

  it("pins each diff to returned root and counts patch rows", async () => {
    request
      .mockResolvedValueOnce(status([entry("both.ts", "M", "M"), entry("new.md", "?", "?")]))
      .mockResolvedValue(diff());
    const result = await load();
    expect(result.files).toHaveLength(3);
    for (const file of result.files) expect(file).toMatchObject({ additions: 1, deletions: 1 });
    expect(request.mock.calls.slice(1).map(([, query]) => query)).toEqual([
      { id: "%1", action: "diff", path: "/repo", file: "both.ts", scope: "unstaged" },
      { id: "%1", action: "diff", path: "/repo", file: "both.ts", scope: "staged" },
      { id: "%1", action: "diff", path: "/repo", file: "new.md", scope: "untracked" },
    ]);
  });

  it("loads both paths of staged renames without mixing unstaged rename metadata", async () => {
    const renamed = { ...entry("next.ts", "R", "M"), originalPath: "old.ts" };
    request.mockResolvedValueOnce(status([renamed])).mockResolvedValue(diff());
    const result = await load();
    expect(result.files[0]?.originalPath).toBeUndefined();
    expect(result.files[1]).toMatchObject({ originalPath: "old.ts", additions: 2, deletions: 2 });
    expect(request.mock.calls.slice(1).map(([, query]) => [query.file, query.scope])).toEqual([
      ["next.ts", "unstaged"],
      ["old.ts", "staged"],
      ["next.ts", "staged"],
    ]);
  });

  it("shows per-file errors while retaining successful and binary files", async () => {
    request
      .mockResolvedValueOnce(status([entry("denied"), entry("good"), entry("image")]))
      .mockRejectedValueOnce(new Error("Access denied"))
      .mockResolvedValueOnce(diff())
      .mockResolvedValueOnce(diff("", true));
    const result = await load();
    expect(result.files[0]?.error).toBe("Access denied");
    expect(result.files[1]?.additions).toBe(1);
    expect(result.files[2]).toMatchObject({ binary: true, additions: null, deletions: null });
  });

  it("limits simultaneous requests and stops scheduling after cancellation", async () => {
    const controller = new AbortController();
    request
      .mockResolvedValueOnce(status(Array.from({ length: 12 }, (_, i) => entry(`${i}.ts`))))
      .mockImplementation(
        (_client, _query, signal) =>
          new Promise((_resolve, reject) => {
            signal?.addEventListener("abort", () =>
              reject(new DOMException("Cancelled", "AbortError")),
            );
          }),
      );
    const pending = load(controller.signal);
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(5));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(request).toHaveBeenCalledTimes(5);
  });

  it("retains file list but marks omitted patches when request limit is reached", async () => {
    request
      .mockResolvedValueOnce(status(Array.from({ length: 205 }, (_, i) => entry(`${i}.ts`))))
      .mockResolvedValue(diff());
    const result = await load();
    expect(request).toHaveBeenCalledTimes(201);
    expect(result.truncated).toBe(true);
    expect(result.files).toHaveLength(205);
    expect(result.files[204]?.patch).toBe("");
  });

  it("bounds retained patches and leaves partial counts unknown", async () => {
    const huge = `@@ -0,0 +1,500000 @@\n${"+line\n".repeat(500_000)}`;
    request.mockResolvedValueOnce(status([entry("huge.ts")])).mockResolvedValue(diff(huge));
    const result = await load();
    expect(result.truncated).toBe(true);
    expect(result.files[0]?.truncated).toBe(true);
    expect(result.files[0]?.additions).toBeNull();
    expect(result.files[0]!.patch.length).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect(result.files[0]!.patch.endsWith("\n")).toBe(true);
  });

  it("keeps clean and unborn repositories empty without diff requests", async () => {
    request.mockResolvedValueOnce(status([]));
    expect((await load()).files).toEqual([]);
    expect(request).toHaveBeenCalledTimes(1);
  });
});
