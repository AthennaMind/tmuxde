import type { FileEntry } from "@/protocol";
import { repositoryRequest, type RepositoryClient } from "@/features/repository/repository-request";
import type { FileLinkTarget } from "./file-links";

/** Probe exact names only. Never search another machine or guess among matches. */
export async function resolveFileLink(
  client: RepositoryClient,
  target: FileLinkTarget,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const query = (action: "context" | "list", path?: string) =>
    repositoryRequest(client, { id: target.paneId, action, ...(path ? { path } : {}) }, signal);
  const context = await query("context");
  signal.throwIfAborted();
  if (context.kind !== "context") throw new Error("Folder context unavailable.");
  const inspect = async (path: string): Promise<FileEntry | undefined> => {
    const clean = path.replace(/\/+$/, "");
    const slash = clean.lastIndexOf("/");
    const name = clean.slice(slash + 1);
    try {
      if (name === "." || name === ".." || clean === "") {
        const result = await query("list", path);
        signal.throwIfAborted();
        if (result.kind !== "list") throw new Error("Folder listing unavailable.");
        return {
          path: result.path,
          name: result.path.split("/").pop() || "/",
          type: "directory",
          size: 0,
          modified: "",
        };
      }
      const result = await query("list", clean.slice(0, slash) || "/");
      signal.throwIfAborted();
      if (result.kind !== "list") throw new Error("Folder listing unavailable.");
      const entry = result.entries.find((item) => item.name === name);
      if (!entry && result.truncated)
        throw new Error("Folder listing truncated. Open path from Files.");
      if (entry && path.endsWith("/") && entry.type !== "directory")
        throw new Error(`Not a directory: ${path}`);
      return entry;
    } catch (error) {
      if (error instanceof Error && error.message === "No such file or directory") return undefined;
      throw error;
    }
  };
  const relative = target.relativePath;
  let base = context.path.replace(/\/+$/, "");
  const direct = await inspect(relative ? `${base}/${relative}` : target.path);
  if (direct) return { entry: direct, context };
  const matches = new Map<string, FileEntry>();
  // Explicit ./ and ../ refer to current folder. Only bare relative paths get fallback.
  const boundaryPath = context.root ?? context.path;
  const boundary = boundaryPath.slice(0, boundaryPath.lastIndexOf("/"));
  if (relative && !/^\.\.?\//.test(relative)) {
    for (let depth = 0; base && depth < 32; depth++) {
      base = base.slice(0, base.lastIndexOf("/"));
      const entry = await inspect(`${base}/${relative}`);
      if (entry) matches.set(entry.path, entry);
      if (base === boundary) break;
    }
  }
  if (matches.size > 1)
    throw new Error(`Multiple paths match "${relative}". Use an absolute path.`);
  const entry = [...matches.values()][0];
  if (!entry) throw new Error(`Path not found: ${relative ?? target.path}`);
  return { entry, context };
}
