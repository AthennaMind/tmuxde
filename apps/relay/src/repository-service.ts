import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import type { FileEntry, RepoRequest, RepoResult } from "@repo/protocol";
import { isPathAllowed } from "./file-service.js";

const READ_LIMIT = 100 * 1024;
const OUTPUT_LIMIT = 512 * 1024;
const ENTRY_LIMIT = 2000;
const TIMEOUT = 5000;
type Request = Pick<RepoRequest, "action" | "path" | "file" | "scope">;
type Repository = { root: string; gitdir: string };

function inside(file: string, root: string): boolean {
  return file === root || file.startsWith(root + path.sep);
}

// Resolve existing ancestors too. Deleted files still need symlink checks.
async function checked(target: string): Promise<string> {
  const absolute = path.resolve(target);
  let resolved: string;
  try {
    resolved = await fs.realpath(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parent = path.dirname(absolute);
    if (parent === absolute) throw error;
    resolved = path.join(await checked(parent), path.basename(absolute));
  }
  if (!isPathAllowed(absolute) || !isPathAllowed(resolved)) {
    throw new Error("Access denied: path outside allowed directories");
  }
  return resolved;
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.lstat(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function textFile(file: string, limit = READ_LIMIT) {
  const safe = await checked(file);
  const handle = await fs.open(safe, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error("Not a regular file");
    const buffer = Buffer.alloc(limit + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const bytes = buffer.subarray(0, Math.min(bytesRead, limit));
    const binary = bytes.includes(0);
    return {
      content: binary ? "" : bytes.toString("utf8"),
      truncated: bytesRead > limit || stat.size > limit,
      binary,
    };
  } finally {
    await handle.close();
  }
}

async function metadataFile(file: string): Promise<string> {
  const value = await textFile(file);
  if (value.truncated || value.binary)
    throw new Error("Unsupported Git metadata");
  return value.content;
}

async function validateGitDirectory(directory: string): Promise<void> {
  await checked(directory);
  // Git follows these paths while reading configuration, refs and objects.
  // Refuse metadata symlinks and alternates so none bypass file permissions.
  let count = 0;
  const deadline = Date.now() + TIMEOUT;
  const pending = [directory];
  while (pending.length) {
    const dir = pending.pop()!;
    const handle = await fs.opendir(dir);
    for await (const entry of handle) {
      if (++count > 100_000 || Date.now() > deadline)
        throw new Error("Git metadata exceeds inspection limit");
      const file = path.join(dir, entry.name);
      if (entry.isSymbolicLink())
        throw new Error("Access denied: Git metadata symlinks are unsupported");
      if (entry.isDirectory()) {
        if (entry.name !== "hooks" && entry.name !== "logs") pending.push(file);
      } else if (
        entry.name === "alternates" ||
        entry.name === "http-alternates"
      ) {
        if ((await metadataFile(file)).trim())
          throw new Error(
            "Access denied: Git object alternates are unsupported",
          );
      } else if (entry.name === "config" || entry.name === "config.worktree") {
        if (
          /^\s*\[\s*(?:include(?:if)?|filter)[\s.\]"]/im.test(
            await metadataFile(file),
          )
        ) {
          throw new Error(
            "Access denied: Git configuration includes and filters are unsupported",
          );
        }
      }
    }
  }
}

async function discover(start: string): Promise<Repository | null> {
  let root = await checked(start);
  if (!(await fs.stat(root)).isDirectory()) throw new Error("Not a directory");
  while (true) {
    const dotgit = path.join(root, ".git");
    if (await exists(dotgit)) {
      await checked(root);
      const safeDotGit = await checked(dotgit);
      let gitdir = safeDotGit;
      if (!(await fs.stat(safeDotGit)).isDirectory()) {
        const match = /^gitdir: (.+)\r?\n?$/.exec(
          await metadataFile(safeDotGit),
        );
        if (!match) throw new Error("Invalid Git directory pointer");
        gitdir = await checked(path.resolve(root, match[1]!));
      }
      await validateGitDirectory(gitdir);
      const commonFile = path.join(gitdir, "commondir");
      if (await exists(commonFile)) {
        const common = await checked(
          path.resolve(gitdir, (await metadataFile(commonFile)).trim()),
        );
        await validateGitDirectory(common);
      }
      return { root, gitdir };
    }
    const parent = path.dirname(root);
    if (parent === root || !isPathAllowed(parent)) return null;
    root = await checked(parent);
  }
}

async function git(
  repo: Repository,
  args: string[],
  accepted = [0],
): Promise<{ content: string; truncated: boolean }> {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  );
  Object.assign(env, {
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_LITERAL_PATHSPECS: "1",
    GIT_NO_LAZY_FETCH: "1",
    LC_ALL: "C",
  });
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      [
        "--no-pager",
        "--git-dir",
        repo.gitdir,
        "--work-tree",
        repo.root,
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "core.untrackedCache=false",
        "-c",
        "protocol.allow=never",
        "-c",
        "diff.submodule=short",
        "-c",
        "core.quotePath=true",
        ...args,
      ],
      {
        cwd: repo.root,
        env,
        encoding: "utf8",
        timeout: TIMEOUT,
        maxBuffer: OUTPUT_LIMIT,
      },
      (error, stdout) => {
        if (error && error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
          resolve({ content: stdout.slice(0, OUTPUT_LIMIT), truncated: true });
        } else if (error && !accepted.includes(Number(error.code))) {
          reject(
            new Error(
              error.killed
                ? "Git request timed out"
                : "Could not read repository",
            ),
          );
        } else resolve({ content: stdout, truncated: false });
      },
    );
  });
}

async function branch(repo: Repository): Promise<string | null> {
  const result = await git(
    repo,
    ["symbolic-ref", "--quiet", "--short", "HEAD"],
    [0, 1],
  );
  return result.content.trim() || null;
}

async function list(directory: string): Promise<RepoResult> {
  const safe = await checked(directory);
  const entries: FileEntry[] = [];
  let truncated = false;
  const handle = await fs.opendir(safe);
  let inspected = 0;
  for await (const entry of handle) {
    if (++inspected > ENTRY_LIMIT) {
      truncated = true;
      break;
    }
    const file = path.join(safe, entry.name);
    try {
      await checked(file);
      const stat = await fs.stat(file);
      entries.push({
        name: entry.name,
        path: file,
        type: stat.isDirectory()
          ? "directory"
          : stat.isFile()
            ? "file"
            : "other",
        size: stat.size,
        modified: stat.mtime.toISOString(),
      });
    } catch {
      /* Skip inaccessible entries. */
    }
  }
  entries.sort(
    (a, b) =>
      Number(b.type === "directory") - Number(a.type === "directory") ||
      a.name.localeCompare(b.name),
  );
  return { kind: "list", path: safe, entries, truncated };
}

export async function repositoryRequest(
  panePath: string,
  request: Request,
): Promise<RepoResult> {
  const cwd = await checked(panePath);
  if (request.action === "list")
    return list(request.path ? path.resolve(cwd, request.path) : cwd);
  if (request.action === "read") {
    if (!request.path) throw new Error("File path required");
    const file = await checked(path.resolve(cwd, request.path));
    return { kind: "read", path: file, ...(await textFile(file)) };
  }
  const repo = await discover(
    request.action !== "context" && request.path
      ? path.resolve(cwd, request.path)
      : cwd,
  );
  if (request.action === "context")
    return {
      kind: "context",
      path: cwd,
      root: repo?.root ?? null,
      branch: repo ? await branch(repo) : null,
    };
  if (request.action === "status") {
    if (!repo)
      return {
        kind: "status",
        root: null,
        branch: null,
        entries: [],
        truncated: false,
      };
    const output = await git(repo, [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      "--ignore-submodules=all",
    ]);
    const records = output.content.split("\0");
    records.pop();
    const entries: Extract<RepoResult, { kind: "status" }>["entries"] = [];
    for (let i = 0; i < records.length && entries.length < ENTRY_LIMIT; i++) {
      const record = records[i]!;
      const index = record[0]!;
      const worktree = record[1]!;
      const file = record.slice(3);
      const originalPath =
        index === "R" || index === "C" || worktree === "R" || worktree === "C"
          ? records[++i]
          : undefined;
      try {
        await checked(path.resolve(repo.root, file));
        if (originalPath) await checked(path.resolve(repo.root, originalPath));
        entries.push({
          path: file,
          index,
          worktree,
          ...(originalPath ? { originalPath } : {}),
        });
      } catch {
        /* Hide paths denied by file policy. */
      }
    }
    return {
      kind: "status",
      root: repo.root,
      branch: await branch(repo),
      entries,
      truncated: output.truncated || records.length > ENTRY_LIMIT,
    };
  }
  if (!repo) throw new Error("Current pane directory is not a Git repository");
  if (!request.file || !request.scope)
    throw new Error("File and change scope required");
  const file = path.resolve(repo.root, request.file);
  if (!inside(file, repo.root))
    throw new Error("Access denied: file outside repository");
  await checked(file);
  let output: { content: string; truncated: boolean };
  if (request.scope === "untracked") {
    const content = await textFile(file);
    const lines = content.content.split("\n");
    const terminated = content.content.endsWith("\n");
    if (terminated) lines.pop();
    const patch = content.content
      ? `--- /dev/null\n+++ ${JSON.stringify(request.file)}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => "+" + line).join("\n")}\n${terminated || content.truncated ? "" : "\\ No newline at end of file\n"}`
      : "";
    output = { content: patch, truncated: content.truncated };
    return {
      kind: "diff",
      path: request.file,
      scope: request.scope,
      ...output,
      binary: content.binary,
    };
  }
  output = await git(repo, [
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "--no-color",
    "--no-renames",
    "--ignore-submodules=all",
    ...(request.scope === "staged" ? ["--cached"] : []),
    "--",
    file,
  ]);
  const binary =
    /^Binary files .* differ$/m.test(output.content) ||
    output.content.includes("GIT binary patch");
  return {
    kind: "diff",
    path: request.file,
    scope: request.scope,
    ...output,
    binary,
  };
}
