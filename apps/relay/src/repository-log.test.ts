import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import type { RepoResult } from "@repo/protocol";

let base: string;
let root: string;
let service: typeof import("./repository-service.js");
const hashes: Record<string, string> = {};

const run = (cwd: string, args: string[], input?: string) =>
  execFileSync("git", ["-c", "commit.gpgsign=false", "-C", cwd, ...args], {
    encoding: "utf8",
    input,
  });
const git = (...args: string[]) => run(root, args);
const commit = (name: string, ...args: string[]) => {
  git("commit", "-q", "-m", name, ...args);
  hashes[name] = git("rev-parse", "HEAD").trim();
};
const init = (dir: string) => {
  run(dir, ["init", "-q", "-b", "main"]);
  run(dir, ["config", "user.email", "test@example.invalid"]);
  run(dir, ["config", "user.name", "Test"]);
};

function as<K extends RepoResult["kind"]>(result: RepoResult, kind: K) {
  if (result.kind !== kind) throw new Error(`Expected ${kind}`);
  return result as Extract<RepoResult, { kind: K }>;
}

beforeAll(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), "tmuxde-log-"));
  root = path.join(base, "repo");
  await fs.mkdir(path.join(root, "secret"), { recursive: true });
  process.env.ALLOWED_PATHS = base;
  // File policy denies the relay's own config folder. Point it inside the
  // repository so one committed file there must stay out of view.
  process.env.TMUXDE_CONFIG_DIR = path.join(root, "secret");
  init(root);
  await fs.writeFile(path.join(root, "a.txt"), "one\ntwo\nthree\nfour\n");
  await fs.writeFile(path.join(root, "secret", "key"), "hidden\n");
  git("add", ".");
  commit("root");
  git("mv", "a.txt", "b.txt");
  await fs.writeFile(path.join(root, "b.txt"), "one\ntwo\nthree\nfive\n");
  await fs.writeFile(path.join(root, "bin.dat"), Buffer.from([0, 1, 2, 0]));
  git("add", ".");
  commit("rename", "-m", "Body line one.\n\nBody line two.");
  git("switch", "-q", "-c", "side");
  await fs.writeFile(path.join(root, "side.txt"), "side\n");
  git("add", ".");
  commit("side");
  git("switch", "-q", "main");
  await fs.writeFile(path.join(root, "main.txt"), "main\n");
  git("add", ".");
  commit("main");
  git("merge", "-q", "--no-ff", "side", "-m", "merge");
  hashes.merge = git("rev-parse", "HEAD").trim();
  for (let i = 0; i < 100; i++) git("commit", "-q", "--allow-empty", "-m", `empty ${i}`);
  git("tag", "v1");
  service = await import("./repository-service.js");
});

afterAll(async () => {
  await fs.rm(base, { recursive: true, force: true });
});

describe("repository history", () => {
  it("pages the log from HEAD", async () => {
    const first = as(await service.repositoryRequest(root, { action: "log" }), "log");
    expect(first).toMatchObject({ root, branch: "main", skip: 0, more: true });
    expect(first.commits).toHaveLength(100);
    expect(first.commits[0]).toMatchObject({
      hash: expect.stringMatching(/^[0-9a-f]{40}$/),
      author: "Test",
      subject: "empty 99",
      refs: ["HEAD -> main", "tag: v1"],
    });
    expect(Date.parse(first.commits[0]!.date)).not.toBeNaN();
    const second = as(
      await service.repositoryRequest(root, { action: "log", skip: 100 }),
      "log",
    );
    expect(second).toMatchObject({ skip: 100, more: false });
    expect(second.commits.map((c) => c.subject)).toEqual([
      "merge",
      "main",
      "side",
      "rename",
      "root",
    ]);
    expect(second.commits[0]!.parents).toEqual([hashes.main, hashes.side]);
    expect(second.commits[4]!.parents).toEqual([]);
  });

  it("answers an empty history before the first commit and outside Git", async () => {
    const fresh = path.join(base, "fresh");
    await fs.mkdir(fresh);
    init(fresh);
    expect(await service.repositoryRequest(fresh, { action: "log" })).toEqual({
      kind: "log",
      root: fresh,
      branch: "main",
      skip: 0,
      commits: [],
      more: false,
    });
    const plain = path.join(base, "plain");
    await fs.mkdir(plain);
    expect(await service.repositoryRequest(plain, { action: "log" })).toMatchObject({
      kind: "log",
      root: null,
      commits: [],
    });
  });

  it("shows a root commit and hides files denied by policy", async () => {
    const result = as(
      await service.repositoryRequest(root, {
        action: "show",
        commit: hashes.root!.slice(0, 7),
      }),
      "show",
    );
    expect(result.commit).toMatchObject({
      hash: hashes.root,
      parents: [],
      email: "test@example.invalid",
      subject: "root",
      body: "",
    });
    expect(result.hidden).toBe(1);
    expect(result.truncated).toBe(false);
    expect(result.files).toEqual([
      {
        path: "a.txt",
        status: "A",
        additions: 4,
        deletions: 0,
        binary: false,
        patch: expect.stringMatching(/^diff --git a\/a.txt b\/a.txt\n.*\+four$/s),
      },
    ]);
  });

  it("shows renames, binary files and the body", async () => {
    const result = as(
      await service.repositoryRequest(root, {
        action: "show",
        commit: hashes.rename!,
      }),
      "show",
    );
    expect(result.commit.body).toBe("Body line one.\n\nBody line two.");
    expect(result.files).toEqual([
      expect.objectContaining({
        path: "b.txt",
        originalPath: "a.txt",
        status: "R",
        additions: 1,
        deletions: 1,
        patch: expect.stringContaining("-four\n+five"),
      }),
      expect.objectContaining({
        path: "bin.dat",
        status: "A",
        additions: null,
        binary: true,
      }),
    ]);
  });

  it("shows a merge against its first parent", async () => {
    const result = as(
      await service.repositoryRequest(root, {
        action: "show",
        commit: hashes.merge!,
      }),
      "show",
    );
    expect(result.commit.parents).toHaveLength(2);
    expect(result.files.map((file) => file.path)).toEqual(["side.txt"]);
  });

  it("refuses malformed and unknown commits", async () => {
    await expect(
      service.repositoryRequest(root, { action: "show", commit: "HEAD~1" }),
    ).rejects.toThrow("Invalid commit");
    await expect(
      service.repositoryRequest(root, { action: "show", commit: "0000000" }),
    ).rejects.toThrow("Commit not found");
    await expect(service.repositoryRequest(root, { action: "show" })).rejects.toThrow(
      "Commit required",
    );
  });

  it("turns off signature checks that run the configured program", async () => {
    const signed = path.join(base, "signed");
    await fs.mkdir(signed);
    init(signed);
    const marker = path.join(base, "gpg-ran");
    const program = path.join(base, "gpg.sh");
    await fs.writeFile(program, `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 });
    run(signed, ["commit", "-q", "--allow-empty", "-m", "unsigned"]);
    // A commit object carrying a signature header, so verification would run.
    const tree = run(signed, ["rev-parse", "HEAD^{tree}"]).trim();
    const parent = run(signed, ["rev-parse", "HEAD"]).trim();
    const object = [
      `tree ${tree}`,
      `parent ${parent}`,
      "author Test <test@example.invalid> 1700000000 +0000",
      "committer Test <test@example.invalid> 1700000000 +0000",
      "gpgsig -----BEGIN PGP SIGNATURE-----",
      " ",
      " AAAA",
      " -----END PGP SIGNATURE-----",
      "",
      "signed",
      "",
    ].join("\n");
    const hash = run(signed, ["hash-object", "-t", "commit", "-w", "--stdin"], object).trim();
    run(signed, ["update-ref", "refs/heads/main", hash]);
    run(signed, ["config", "log.showSignature", "true"]);
    run(signed, ["config", "gpg.program", program]);

    // Git either runs the program or, where temp folders refuse to execute,
    // reports that it tried. Both count as an attempt.
    const attempted = async (args: string[]) => {
      await fs.rm(marker, { force: true });
      const { stderr } = spawnSync("git", ["-C", signed, ...args], {
        encoding: "utf8",
      });
      const ran = await fs.stat(marker).then(() => true, () => false);
      return ran || stderr.includes(program);
    };
    // Control: the fixture does trigger a check without the flags.
    expect(await attempted(["log", "-1", "--format=%s"])).toBe(true);
    expect(await attempted(["log", ...service.HISTORY_FLAGS, "-1", "--format=%s"])).toBe(false);
    expect(await attempted(["show", "-s", ...service.HISTORY_FLAGS, "--format=%s", hash])).toBe(false);

    const log = as(await service.repositoryRequest(signed, { action: "log" }), "log");
    expect(log.commits[0]!.subject).toBe("signed");
    await service.repositoryRequest(signed, { action: "show", commit: hash });
    await expect(fs.stat(marker)).rejects.toThrow();
  });
});

describe("parseCommitTree", () => {
  it("keeps files whose patch was cut off", () => {
    const content = [
      ":100644 100644 aaa bbb M",
      "one.txt",
      ":000000 100644 000 ccc A",
      "two.txt",
      "1\t1\tone.txt",
      "3\t0\ttwo.txt",
      "",
      "diff --git a/one.txt b/one.txt\n@@ -1 +1 @@\n-a\n+b\n",
    ].join("\0");
    expect(service.parseCommitTree(content)).toEqual([
      {
        path: "one.txt",
        status: "M",
        additions: 1,
        deletions: 1,
        binary: false,
        patch: "diff --git a/one.txt b/one.txt\n@@ -1 +1 @@\n-a\n+b",
      },
      {
        path: "two.txt",
        status: "A",
        additions: 3,
        deletions: 0,
        binary: false,
        patch: "",
      },
    ]);
  });

  it("reads rename counts printed as separate path records", () => {
    const content = [
      ":100644 100644 aaa bbb R090",
      "old.txt",
      "new.txt",
      "2\t1\t",
      "old.txt",
      "new.txt",
      "",
      "diff --git a/old.txt b/new.txt\nrename from old.txt\nrename to new.txt\n",
    ].join("\0");
    expect(service.parseCommitTree(content)).toEqual([
      expect.objectContaining({
        path: "new.txt",
        originalPath: "old.txt",
        status: "R",
        additions: 2,
        deletions: 1,
      }),
    ]);
  });
});
