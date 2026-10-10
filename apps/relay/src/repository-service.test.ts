import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

let base: string;
let root: string;
let service: typeof import("./repository-service.js");
const git = (...args: string[]) =>
  execFileSync("git", ["-c", "commit.gpgsign=false", "-C", root, ...args], {
    encoding: "utf8",
  });
beforeAll(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), "mtmux-repo-"));
  root = path.join(base, "repo");
  await fs.mkdir(root);
  process.env.ALLOWED_PATHS = root;
  git("init", "-q");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "Test");
  await fs.writeFile(path.join(root, "both.txt"), "base\n");
  await fs.writeFile(path.join(root, "delete.txt"), "removed\n");
  await fs.writeFile(path.join(root, "old name.txt"), "renamed\n");
  git("add", ".");
  git("commit", "-m", "fixture");
  await fs.writeFile(path.join(root, "both.txt"), "staged\n");
  git("add", "both.txt");
  await fs.writeFile(path.join(root, "both.txt"), "working\n");
  await fs.unlink(path.join(root, "delete.txt"));
  git("mv", "old name.txt", "new name.txt");
  await fs.writeFile(path.join(root, ":(glob)*\n.txt"), "new file\n");
  service = await import("./repository-service.js");
});
afterAll(async () => {
  await fs.rm(base, { recursive: true, force: true });
});

describe("repository reads", () => {
  it("reports staged, unstaged, renamed and unusual untracked names", async () => {
    const result = await service.repositoryRequest(root, { action: "status" });
    expect(result.kind).toBe("status");
    if (result.kind !== "status") throw new Error("Wrong result");
    expect(result.root).toBe(root);
    expect(result.entries).toEqual(
      expect.arrayContaining([
        { path: "both.txt", index: "M", worktree: "M" },
        { path: "delete.txt", index: " ", worktree: "D" },
        {
          path: "new name.txt",
          originalPath: "old name.txt",
          index: "R",
          worktree: " ",
        },
        { path: ":(glob)*\n.txt", index: "?", worktree: "?" },
      ]),
    );
  });
  it("separates staged and unstaged diffs", async () => {
    const staged = await service.repositoryRequest(root, {
      action: "diff",
      file: "both.txt",
      scope: "staged",
    });
    const unstaged = await service.repositoryRequest(root, {
      action: "diff",
      file: "both.txt",
      scope: "unstaged",
    });
    expect(staged).toMatchObject({
      kind: "diff",
      content: expect.stringContaining("+staged"),
    });
    expect(unstaged).toMatchObject({
      kind: "diff",
      content: expect.stringContaining("+working"),
    });
  });
  it("handles deleted and literal untracked paths", async () => {
    expect(
      await service.repositoryRequest(root, {
        action: "diff",
        file: "delete.txt",
        scope: "unstaged",
      }),
    ).toMatchObject({
      kind: "diff",
      content: expect.stringContaining("-removed"),
    });
    expect(
      await service.repositoryRequest(root, {
        action: "diff",
        file: ":(glob)*\n.txt",
        scope: "untracked",
      }),
    ).toMatchObject({
      kind: "diff",
      content: expect.stringContaining("+new file"),
    });
  });
  it("rejects traversal and symlinks outside allowed paths", async () => {
    await fs.writeFile(path.join(base, "secret"), "secret");
    await fs.symlink(path.join(base, "secret"), path.join(root, "escape"));
    await expect(
      service.repositoryRequest(root, {
        action: "read",
        path: path.join(root, "escape"),
      }),
    ).rejects.toThrow(/denied/i);
    await expect(
      service.repositoryRequest(root, {
        action: "diff",
        file: "../secret",
        scope: "unstaged",
      }),
    ).rejects.toThrow(/denied/i);
  });
  it("bounds text reads and detects binary files", async () => {
    await fs.writeFile(path.join(root, "large.txt"), "x".repeat(200_000));
    await fs.writeFile(path.join(root, "binary.dat"), Buffer.from([0, 1, 2]));
    expect(
      await service.repositoryRequest(root, {
        action: "read",
        path: path.join(root, "large.txt"),
      }),
    ).toMatchObject({ kind: "read", truncated: true });
    expect(
      await service.repositoryRequest(root, {
        action: "read",
        path: path.join(root, "binary.dat"),
      }),
    ).toMatchObject({ kind: "read", binary: true, content: "" });
  });
  it("returns a clear non-repository context", async () => {
    const outside = path.join(root, "plain");
    await fs.mkdir(outside);
    await fs.rename(path.join(root, ".git"), path.join(root, "saved-git"));
    try {
      expect(
        await service.repositoryRequest(outside, { action: "context" }),
      ).toEqual({ kind: "context", path: outside, root: null, branch: null });
    } finally {
      await fs.rename(path.join(root, "saved-git"), path.join(root, ".git"));
    }
  });
  it("rejects Git metadata symlink escapes before invoking Git", async () => {
    const linked = path.join(root, "linked");
    await fs.mkdir(linked);
    await fs.symlink(path.join(base, "secret"), path.join(linked, ".git"));
    await expect(
      service.repositoryRequest(linked, { action: "context" }),
    ).rejects.toThrow(/denied/i);
  });
  it("supports staged changes before first commit", async () => {
    const unborn = path.join(root, "unborn");
    await fs.mkdir(unborn);
    execFileSync("git", ["-C", unborn, "init", "-q"]);
    await fs.writeFile(path.join(unborn, "first.txt"), "first\n");
    execFileSync("git", ["-C", unborn, "add", "."]);
    expect(
      await service.repositoryRequest(unborn, {
        action: "diff",
        file: "first.txt",
        scope: "staged",
      }),
    ).toMatchObject({
      kind: "diff",
      content: expect.stringContaining("+first"),
    });
  });
  it("does not execute fsmonitor, external diff or textconv programs", async () => {
    const marker = path.join(root, "executed");
    const command = `touch ${marker}`;
    git("config", "core.fsmonitor", command);
    git("config", "diff.external", command);
    git("config", "diff.unsafe.textconv", command);
    await fs.writeFile(
      path.join(root, ".gitattributes"),
      "both.txt diff=unsafe\n",
    );
    try {
      await service.repositoryRequest(root, { action: "status" });
      await service.repositoryRequest(root, {
        action: "diff",
        file: "both.txt",
        scope: "unstaged",
      });
      await expect(fs.stat(marker)).rejects.toThrow();
    } finally {
      git("config", "--unset", "core.fsmonitor");
      git("config", "--unset", "diff.external");
      git("config", "--unset", "diff.unsafe.textconv");
      await fs.unlink(path.join(root, ".gitattributes"));
    }
  });

  it("rejects Git pointers and nested metadata escaping allow list", async () => {
    const pointer = path.join(root, "pointer");
    await fs.mkdir(pointer);
    await fs.writeFile(path.join(pointer, ".git"), `gitdir: ${base}\n`);
    await expect(
      service.repositoryRequest(pointer, { action: "context" }),
    ).rejects.toThrow(/denied/i);
    const link = path.join(root, ".git", "objects", "escape");
    await fs.symlink(base, link);
    try {
      await expect(
        service.repositoryRequest(root, { action: "context" }),
      ).rejects.toThrow(/denied/i);
    } finally {
      await fs.unlink(link);
    }
  });

  it("supports linked worktrees within allowed paths", async () => {
    const worktree = path.join(root, "worktree");
    git("worktree", "add", "--detach", worktree);
    expect(
      await service.repositoryRequest(worktree, { action: "context" }),
    ).toMatchObject({ kind: "context", root: worktree, branch: null });
  });

  it("bounds Git diff output", async () => {
    const large = path.join(root, "large-diff.txt");
    await fs.writeFile(large, "baseline\n");
    git("add", "large-diff.txt");
    await fs.writeFile(large, "changed line\n".repeat(80_000));
    const result = await service.repositoryRequest(root, {
      action: "diff",
      file: "large-diff.txt",
      scope: "unstaged",
    });
    expect(result).toMatchObject({ kind: "diff", truncated: true });
    if (result.kind === "diff")
      expect(result.content.length).toBeLessThanOrEqual(512 * 1024);
  });

  it("detects binary Git diffs", async () => {
    const binary = path.join(root, "tracked.dat");
    await fs.writeFile(binary, Buffer.from([0, 1, 2]));
    git("add", "tracked.dat");
    await fs.writeFile(binary, Buffer.from([0, 3, 4]));
    expect(
      await service.repositoryRequest(root, {
        action: "diff",
        file: "tracked.dat",
        scope: "unstaged",
      }),
    ).toMatchObject({ kind: "diff", binary: true });
  });

  it("rejects configured clean filters before Git can execute them", async () => {
    const marker = path.join(root, "filter-ran");
    git("config", "filter.unsafe.clean", `touch ${marker}; cat`);
    await fs.writeFile(
      path.join(root, ".gitattributes"),
      "both.txt filter=unsafe\n",
    );
    try {
      await expect(
        service.repositoryRequest(root, {
          action: "diff",
          file: "both.txt",
          scope: "unstaged",
        }),
      ).rejects.toThrow(/filters are unsupported/);
      await expect(fs.stat(marker)).rejects.toThrow();
    } finally {
      git("config", "--unset", "filter.unsafe.clean");
      await fs.unlink(path.join(root, ".gitattributes"));
    }
  });

  it("builds accurate untracked patches with and without final newline", async () => {
    const file = path.join(root, "untracked-content.txt");
    await fs.writeFile(file, "one\ntwo\n");
    expect(
      await service.repositoryRequest(root, {
        action: "diff",
        file,
        scope: "untracked",
      }),
    ).toMatchObject({
      kind: "diff",
      content: expect.stringContaining("@@ -0,0 +1,2 @@\n+one\n+two\n"),
    });
    await fs.writeFile(file, "one");
    expect(
      await service.repositoryRequest(root, {
        action: "diff",
        file,
        scope: "untracked",
      }),
    ).toMatchObject({
      kind: "diff",
      content: expect.stringContaining(
        "@@ -0,0 +1,1 @@\n+one\n\\ No newline at end of file\n",
      ),
    });
    await fs.writeFile(file, "");
    expect(
      await service.repositoryRequest(root, {
        action: "diff",
        file,
        scope: "untracked",
      }),
    ).toMatchObject({ kind: "diff", content: "" });
  });

  it("keeps selected repository context when pane changes directory", async () => {
    const result = await service.repositoryRequest(path.join(root, "unborn"), {
      action: "status",
      path: root,
    });
    expect(result).toMatchObject({ kind: "status", root });
  });
});
