import fs from "node:fs/promises";
import { realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { watch } from "chokidar";
import { createLogger } from "@repo/logger";
import type { FileEntry, FileStat } from "@repo/protocol";
import { config } from "./config.js";

const logger = createLogger("relay:files");

const MAX_FILE_SIZE = 100 * 1024; // 100KB
const MAX_WRITE_SIZE = 1 * 1024 * 1024; // 1MB
const MAX_UPLOAD_SIZE = 10 * 1024 * 1024; // 10MB

/**
 * In-progress upload state for a single connection: resolved path → accumulated
 * byte count. Kept per-connection (see ConnectionState.uploads) so concurrent
 * connections can't corrupt each other's partial files and leaks are cleaned on
 * disconnect.
 */
export type UploadState = Map<string, number>;

/**
 * The directory the file browser should open to by default: the first
 * configured allowed path, resolved to an absolute path. Falls back to $HOME
 * and then the filesystem root so clients always receive something listable.
 */
export function defaultBrowsePath(): string {
  return path.resolve(config.allowedPaths[0] ?? process.env.HOME ?? "/");
}

/**
 * Resolve a path to its canonical real location, following symlinks. If the
 * path itself doesn't exist yet (e.g. the target of a create/mkdir/upload), the
 * PARENT directory is realpath'd and the basename re-appended — this still
 * resolves any symlink in the existing ancestor chain while allowing new files.
 * Falls back to the lexical resolve when even the parent is missing.
 */
function realpathResolve(targetPath: string): string {
  const resolved = path.resolve(targetPath);
  try {
    return realpathSync(resolved);
  } catch {
    const parent = path.dirname(resolved);
    const base = path.basename(resolved);
    try {
      return path.join(realpathSync(parent), base);
    } catch {
      return resolved;
    }
  }
}

/**
 * Directories no grant may ever read, list, write or traverse.
 *
 * `config.allowedPaths` is `$HOME` for every `mtmux start`, and
 * `~/.mtmux/config.json` holds `AUTH_TOKEN` — which `auth.ts` trades for
 * `FULL_GRANT`. Without this, one `file:read` on a deliberately read-only
 * share returns a full shell. The neighbouring dotfile directories are the
 * same escalation by a different route (an SSH key, a cloud credential, a
 * `gh` token).
 *
 * Deliberately NOT configurable. A deny-list you can switch off is a
 * deny-list an attacker asks you to switch off, and nothing legitimate about
 * a remote terminal needs the browser to read these through the file API — a
 * full-grant shell can still `cat` them, which is the point: the escalation
 * this closes is the *scoped* grant, not the interactive one.
 */
function deniedRoots(): string[] {
  const home = os.homedir();
  const configDir = process.env.MTMUX_CONFIG_DIR ?? path.join(home, ".mtmux");
  return [
    configDir,
    path.join(home, ".mtmux"),
    path.join(home, ".tmuxremote"),
    path.join(home, ".ssh"),
    path.join(home, ".aws"),
    path.join(home, ".gnupg"),
    path.join(home, ".config", "gh"),
    path.join(home, ".kube"),
  ];
}

/**
 * Resolved once, alongside `config`, for the same reason: these are process
 * identity, not per-request state, and re-resolving them on every path check
 * would put a `realpath` syscall in the hot loop of a directory listing.
 */
const DENIED_ROOTS = deniedRoots().map(realpathResolve);

function isWithin(resolved: string, root: string): boolean {
  return resolved === root || resolved.startsWith(root + path.sep);
}

/**
 * True when `targetPath` sits inside a denied root.
 *
 * Compared after `realpathResolve`, so a symlink planted inside an allowed
 * directory that points at `~/.ssh` is caught, and a sibling like
 * `~/.mtmuxfoo` — which merely shares a string prefix — is not.
 */
export function isPathDenied(targetPath: string): boolean {
  const resolved = realpathResolve(targetPath);
  return DENIED_ROOTS.some((root) => isWithin(resolved, root));
}

/**
 * The single gate.
 *
 * The deny check lives here rather than in `assertPathAllowed` because this
 * is the function everything actually calls: `server.ts`'s HTTP download path
 * and ten sites in `message-router.ts` call it directly, so a deny placed in
 * the wrapper would be bypassed by every one of them.
 */
export function isPathAllowed(targetPath: string): boolean {
  const resolved = realpathResolve(targetPath);
  if (DENIED_ROOTS.some((root) => isWithin(resolved, root))) return false;
  return config.allowedPaths.some((allowed) => {
    const resolvedAllowed = realpathResolve(allowed);
    return isWithin(resolved, resolvedAllowed);
  });
}

function assertPathAllowed(targetPath: string): string {
  const resolved = realpathResolve(targetPath);
  if (!isPathAllowed(targetPath)) {
    throw new Error(`Access denied: path outside allowed directories`);
  }
  return resolved;
}

function fileTypeFromDirent(dirent: {
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}): FileEntry["type"] {
  if (dirent.isFile()) return "file";
  if (dirent.isDirectory()) return "directory";
  if (dirent.isSymbolicLink()) return "symlink";
  return "other";
}

export async function listDirectory(dirPath: string): Promise<FileEntry[]> {
  const resolved = assertPathAllowed(dirPath);
  const entries = await fs.readdir(resolved, { withFileTypes: true });

  const results: FileEntry[] = [];
  for (const entry of entries) {
    try {
      const fullPath = path.join(resolved, entry.name);
      const stat = await fs.stat(fullPath);
      results.push({
        name: entry.name,
        path: fullPath,
        type: fileTypeFromDirent(entry),
        size: stat.size,
        modified: stat.mtime.toISOString(),
      });
    } catch {
      // Skip entries we can't stat
    }
  }

  return results.sort((a, b) => {
    if (a.type === "directory" && b.type !== "directory") return -1;
    if (a.type !== "directory" && b.type === "directory") return 1;
    return a.name.localeCompare(b.name);
  });
}

export async function readFile(
  filePath: string,
): Promise<{ content: string; truncated: boolean }> {
  const resolved = assertPathAllowed(filePath);
  const stat = await fs.stat(resolved);

  if (!stat.isFile()) {
    throw new Error("Not a file");
  }

  if (stat.size > MAX_FILE_SIZE) {
    const buffer = Buffer.alloc(MAX_FILE_SIZE);
    const handle = await fs.open(resolved, "r");
    try {
      await handle.read(buffer, 0, MAX_FILE_SIZE, 0);
      return { content: buffer.toString("utf-8"), truncated: true };
    } finally {
      await handle.close();
    }
  }

  const content = await fs.readFile(resolved, "utf-8");
  return { content, truncated: false };
}

export async function getStats(filePath: string): Promise<FileStat> {
  const resolved = assertPathAllowed(filePath);
  const stat = await fs.stat(resolved);

  let permissions: string;
  try {
    await fs.access(resolved, fs.constants.R_OK);
    permissions = "r";
    try {
      await fs.access(resolved, fs.constants.W_OK);
      permissions += "w";
    } catch {
      // not writable
    }
  } catch {
    permissions = "-";
  }

  return {
    name: path.basename(resolved),
    path: resolved,
    type: stat.isFile()
      ? "file"
      : stat.isDirectory()
        ? "directory"
        : stat.isSymbolicLink()
          ? "symlink"
          : "other",
    size: stat.size,
    modified: stat.mtime.toISOString(),
    created: stat.birthtime.toISOString(),
    permissions,
    isReadable: permissions.includes("r"),
    isWritable: permissions.includes("w"),
  };
}

export async function writeFile(
  filePath: string,
  content: string,
): Promise<{ size: number }> {
  const resolved = assertPathAllowed(filePath);
  const bytes = Buffer.byteLength(content, "utf-8");
  if (bytes > MAX_WRITE_SIZE) {
    throw new Error(
      `File too large to write (${bytes} bytes, max ${MAX_WRITE_SIZE})`,
    );
  }
  await fs.access(resolved, fs.constants.W_OK);
  await fs.writeFile(resolved, content, "utf-8");
  return { size: bytes };
}

export async function createFile(
  filePath: string,
  content = "",
): Promise<void> {
  const resolved = assertPathAllowed(filePath);
  // wx flag: create exclusive — fails if file exists
  await fs.writeFile(resolved, content, { encoding: "utf-8", flag: "wx" });
}

export async function mkdir(dirPath: string): Promise<void> {
  const resolved = assertPathAllowed(dirPath);
  await fs.mkdir(resolved, { recursive: false });
}

export async function deleteFile(filePath: string): Promise<void> {
  const resolved = assertPathAllowed(filePath);
  // Guard: cannot delete an allowed root
  const isRoot = config.allowedPaths.some(
    (allowed) => realpathResolve(allowed) === resolved,
  );
  if (isRoot) {
    throw new Error("Cannot delete an allowed root directory");
  }
  await fs.rm(resolved, { recursive: true });
}

export async function renameFile(
  oldPath: string,
  newPath: string,
): Promise<void> {
  const resolvedOld = assertPathAllowed(oldPath);
  const resolvedNew = assertPathAllowed(newPath);
  await fs.rename(resolvedOld, resolvedNew);
}

export async function handleUpload(
  uploads: UploadState,
  filePath: string,
  base64Chunk: string,
  final: boolean,
): Promise<void> {
  const resolved = assertPathAllowed(filePath);
  const chunk = Buffer.from(base64Chunk, "base64");

  const currentSize = uploads.get(resolved) ?? 0;
  const newSize = currentSize + chunk.length;
  if (newSize > MAX_UPLOAD_SIZE) {
    uploads.delete(resolved);
    // Remove the partial file so a rejected oversize upload leaves nothing behind.
    await fs.rm(resolved, { force: true }).catch(() => {});
    throw new Error(
      `Upload too large (${newSize} bytes, max ${MAX_UPLOAD_SIZE})`,
    );
  }

  if (currentSize === 0) {
    // First chunk — create/truncate
    await fs.writeFile(resolved, chunk);
  } else {
    await fs.appendFile(resolved, chunk);
  }

  if (final) {
    uploads.delete(resolved);
  } else {
    uploads.set(resolved, newSize);
  }
}

/**
 * Abort any in-progress uploads for a connection: unlink each partial file and
 * clear the tracking map. Called from removeConnection on disconnect.
 */
export async function cleanupUploads(uploads: UploadState): Promise<void> {
  for (const resolved of uploads.keys()) {
    await fs.rm(resolved, { force: true }).catch(() => {});
  }
  uploads.clear();
}

export interface DirectoryWatcher {
  close(): Promise<void>;
}

export function watchDirectory(
  dirPath: string,
  onChange: (
    event: "add" | "change" | "unlink" | "addDir" | "unlinkDir",
    filePath: string,
  ) => void,
): DirectoryWatcher {
  const resolved = assertPathAllowed(dirPath);

  const watcher = watch(resolved, {
    depth: 0,
    ignoreInitial: true,
    persistent: true,
  });

  watcher.on("all", (event, filePath) => {
    const validEvents = [
      "add",
      "change",
      "unlink",
      "addDir",
      "unlinkDir",
    ] as const;
    if (validEvents.includes(event as (typeof validEvents)[number])) {
      onChange(event as (typeof validEvents)[number], filePath);
    }
  });

  watcher.on("error", (err) => {
    logger.error({ err, path: resolved }, "File watcher error");
  });

  return {
    close(): Promise<void> {
      return watcher.close();
    },
  };
}
