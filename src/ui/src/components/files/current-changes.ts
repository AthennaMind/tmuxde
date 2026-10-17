import type { RepoResult } from "@/protocol";
import { parsePatch } from "./commit-diff";
import type { DiffFile, FileChangesResult } from "./commit-view";
import { repositoryRequest, type RepositoryClient } from "./repository-request";

type Status = Extract<RepoResult, { kind: "status" }>;
type Scope = "staged" | "unstaged" | "untracked";

export interface CurrentChangesResult extends FileChangesResult {
  root: string | null;
  branch: string | null;
}

/** Keep requests and retained patch text bounded for large working trees. */
const MAX_PATCHES = 200;
const MAX_PATCH_CHARS = 2 * 1024 * 1024;

export function currentChangeFiles(entries: Status["entries"]): DiffFile[] {
  return (["unstaged", "staged", "untracked"] as Scope[]).flatMap((scope) =>
    entries.flatMap((entry): DiffFile[] => {
      const untracked = entry.index === "?" || entry.worktree === "?";
      const status = scope === "staged" ? entry.index : entry.worktree;
      if (scope === "untracked" ? !untracked : untracked || [" ", "!", "?"].includes(status))
        return [];
      return [{
        path: entry.path,
        originalPath: status === "R" || status === "C" ? entry.originalPath : undefined,
        status: scope === "untracked" ? "?" : status,
        scope,
        additions: null,
        deletions: null,
        binary: false,
        patch: "",
      }];
    }),
  );
}

/** Read each scope separately so partially staged files retain both patches. */
export async function loadCurrentChanges(
  client: RepositoryClient,
  paneId: string,
  path: string,
  signal: AbortSignal,
): Promise<CurrentChangesResult> {
  const status = await repositoryRequest(client, { id: paneId, action: "status", path }, signal);
  if (status.kind !== "status") throw new Error("Unexpected changes response.");
  const files = currentChangeFiles(status.entries);
  const result: CurrentChangesResult = {
    root: status.root,
    branch: status.branch,
    files,
    hidden: 0,
    truncated: status.truncated || files.length > MAX_PATCHES,
  };
  const contextPath = status.root ?? path;
  let next = 0;
  let retained = 0;
  async function worker() {
    while (next < Math.min(files.length, MAX_PATCHES) && retained < MAX_PATCH_CHARS) {
      signal.throwIfAborted();
      const index = next++;
      const file = files[index]!;
      try {
        // Diff requests disable rename detection. Read both paths of a rename.
        const paths = file.status === "R" && file.originalPath
          ? [file.originalPath, file.path]
          : [file.path];
        let patch = "";
        let binary = false;
        let truncated = false;
        for (const name of paths) {
          const diff = await repositoryRequest(client, {
            id: paneId, action: "diff", path: contextPath,
            file: name, scope: file.scope,
          }, signal);
          if (diff.kind !== "diff") throw new Error("Unexpected diff response.");
          patch += diff.content;
          binary ||= diff.binary;
          truncated ||= diff.truncated;
        }
        const remaining = Math.max(0, MAX_PATCH_CHARS - retained);
        if (patch.length > remaining) {
          // Drop partial lines so counts and line numbers do not imply full output.
          patch = patch.slice(0, remaining);
          patch = patch.slice(0, Math.max(0, patch.lastIndexOf("\n") + 1));
          truncated = true;
        }
        retained += patch.length;
        if (truncated) result.truncated = true;
        const rows = binary || truncated ? [] : parsePatch(patch).rows;
        files[index] = {
          ...file, patch, binary, truncated,
          additions: binary || truncated ? null : rows.filter((row) => row.kind === "add").length,
          deletions: binary || truncated ? null : rows.filter((row) => row.kind === "del").length,
        };
      } catch (error) {
        signal.throwIfAborted();
        if (client.status !== "connected") throw error;
        files[index] = { ...file, error: error instanceof Error ? error.message : "Could not load diff." };
      }
    }
  }
  await Promise.all(Array.from({ length: 4 }, worker));
  if (next < files.length) result.truncated = true;
  return result;
}
