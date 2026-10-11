import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import type {
  FileEntry,
  RepoCommit,
  RepoCommitFile,
  RepoRequest,
  RepoResult,
} from "@repo/protocol";
import { isPathAllowed } from "./file-service.js";

const READ_LIMIT = 100 * 1024;
const OUTPUT_LIMIT = 512 * 1024;
const ENTRY_LIMIT = 2000;
const TIMEOUT = 5000;
const LOG_PAGE = 100;
type Request = Pick<
  RepoRequest,
  "action" | "path" | "file" | "scope" | "skip" | "commit"
>;
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

// History reads never verify signatures, map names or show notes. Signature
// checks run the configured GPG program, and mailmap and notes read more
// files than the commit itself.
export const HISTORY_FLAGS = [
  "--no-show-signature",
  "--no-mailmap",
  "--no-notes",
  "--no-color",
];
const FIELD = "\x1f";
// Subject last: it is free text, so a stray separator only lands in it.
const LOG_FORMAT = "%H%x1f%P%x1f%an%x1f%aI%x1f%D%x1f%s";
const SHOW_FORMAT = "%H%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%cn%x1f%cI%x1f%D%x1f%s%x1f%b";

function summary(fields: string[]): RepoCommit {
  const [hash = "", parents = "", author = "", date = "", refs = ""] = fields;
  return {
    hash,
    parents: parents ? parents.split(" ") : [],
    author,
    date,
    subject: fields.slice(5).join(FIELD),
    refs: refs ? refs.split(", ") : [],
  };
}

async function log(repo: Repository, skip: number): Promise<RepoResult> {
  const base = {
    kind: "log" as const,
    root: repo.root,
    branch: await branch(repo),
    skip,
  };
  // A new repository has no HEAD commit yet. That is an empty history.
  const head = await git(repo, ["rev-parse", "--verify", "-q", "HEAD"], [0, 1]);
  if (!head.content.trim()) return { ...base, commits: [], more: false };
  const output = await git(repo, [
    "log",
    ...HISTORY_FLAGS,
    "-z",
    `--format=${LOG_FORMAT}`,
    `--max-count=${LOG_PAGE + 1}`,
    `--skip=${skip}`,
    "--end-of-options",
    "HEAD",
  ]);
  const records = output.content.split("\0").filter(Boolean);
  // Output cut at the limit ends in a partial record.
  if (output.truncated) records.pop();
  return {
    ...base,
    commits: records
      .slice(0, LOG_PAGE)
      .map((record) => summary(record.split(FIELD))),
    more: records.length > LOG_PAGE || output.truncated,
  };
}

type TreeFile = Pick<RepoCommitFile, "path" | "originalPath" | "status">;

/**
 * Split `diff-tree -z --raw --numstat -p` output into files.
 *
 * All three formats come from one diff queue, so raw record, count and patch
 * section `n` describe the same file. Output cut at the limit leaves the tail
 * without counts or patch.
 */
export function parseCommitTree(content: string): RepoCommitFile[] {
  const tokens = content.split("\0");
  let i = 0;
  const files: TreeFile[] = [];
  while (tokens[i]?.startsWith(":")) {
    const status = tokens[i]!.split(" ").pop()?.[0] ?? "M";
    const pair = status === "R" || status === "C";
    const first = tokens[i + 1];
    const second = pair ? tokens[i + 2] : first;
    if (first === undefined || second === undefined) break;
    files.push(
      pair
        ? { path: second, originalPath: first, status }
        : { path: first, status },
    );
    i += pair ? 3 : 2;
  }
  while (tokens[i] === "") i++;
  const counts: { additions: number | null; deletions: number | null }[] = [];
  while (counts.length < files.length && i < tokens.length) {
    const match = /^(-|\d+)\t(-|\d+)\t([^]*)$/.exec(tokens[i]!);
    if (!match) break;
    counts.push({
      additions: match[1] === "-" ? null : Number(match[1]),
      deletions: match[2] === "-" ? null : Number(match[2]),
    });
    // A rename prints its two paths as their own records.
    i += match[3] ? 1 : 3;
  }
  const patch = tokens.slice(i).join("\0").replace(/^\0+/, "");
  const sections = patch
    .split(/^(?=diff --git )/m)
    .filter((section) => section.startsWith("diff --git "));
  return files.map((file, index) => {
    const count = counts[index];
    const section = (sections[index] ?? "").replace(/\n$/, "");
    const binary =
      (count !== undefined && count.additions === null) ||
      /^Binary files .* differ$/m.test(section);
    return {
      ...file,
      additions: count?.additions ?? null,
      deletions: count?.deletions ?? null,
      binary,
      patch: section,
    };
  });
}

async function show(repo: Repository, commit: string): Promise<RepoResult> {
  if (!/^[0-9a-f]{7,64}$/.test(commit)) throw new Error("Invalid commit");
  const resolved = await git(
    repo,
    ["rev-parse", "--verify", "-q", `${commit}^{commit}`],
    [0, 1],
  );
  const hash = resolved.content.trim();
  if (!/^[0-9a-f]{40,64}$/.test(hash)) throw new Error("Commit not found");
  const meta = await git(repo, [
    "show",
    "-s",
    ...HISTORY_FLAGS,
    `--format=${SHOW_FORMAT}`,
    "--end-of-options",
    hash,
  ]);
  const fields = meta.content.split(FIELD);
  const [, parents = "", author = "", email = "", date = ""] = fields;
  const [committer = "", committerDate = "", refs = "", subject = ""] =
    fields.slice(5);
  const output = await git(repo, [
    "diff-tree",
    "-r",
    "-z",
    "-M",
    "--root",
    "--raw",
    "--numstat",
    "-p",
    "--no-commit-id",
    "--no-abbrev",
    // A merge shows what it brought in over the branch it was merged into.
    "--diff-merges=first-parent",
    "--no-ext-diff",
    "--no-textconv",
    "--no-color",
    "--end-of-options",
    hash,
  ]);
  const files: RepoCommitFile[] = [];
  let hidden = 0;
  const all = parseCommitTree(output.content);
  for (const file of all.slice(0, ENTRY_LIMIT)) {
    try {
      for (const name of [file.path, file.originalPath]) {
        if (name === undefined) continue;
        const absolute = path.resolve(repo.root, name);
        if (!inside(absolute, repo.root))
          throw new Error("Access denied: file outside repository");
        await checked(absolute);
      }
      files.push(file);
    } catch {
      // Same rule as status: paths file policy denies stay out of view.
      hidden++;
    }
  }
  return {
    kind: "show",
    root: repo.root,
    commit: {
      hash,
      parents: parents ? parents.split(" ") : [],
      author,
      email,
      date,
      committer,
      committerDate,
      refs: refs ? refs.split(", ") : [],
      subject,
      body: fields.slice(9).join(FIELD).trim(),
    },
    files,
    hidden,
    truncated: output.truncated || all.length > ENTRY_LIMIT,
  };
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
  if (request.action === "log") {
    if (!repo)
      return {
        kind: "log",
        root: null,
        branch: null,
        skip: 0,
        commits: [],
        more: false,
      };
    return log(repo, request.skip ?? 0);
  }
  if (!repo) throw new Error("Current pane directory is not a Git repository");
  if (request.action === "show") {
    if (!request.commit) throw new Error("Commit required");
    return show(repo, request.commit);
  }
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
