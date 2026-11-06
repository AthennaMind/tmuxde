import type { RepoResult } from "@/protocol";
import { machineId } from "@/features/connection/machine-context";
import { draftKey, draftProtected, useFileDrafts } from "@/features/files/file-drafts";
import { useFileStore } from "@/features/files/file-store";
import { isReadOnly, useConnectionStore } from "@/features/connection/connection-store";
import { repositoryRequest, type RepositoryClient } from "./repository-request";
import { useRepoWatchStore } from "./repo-watch-store";

export type ChangeEntry = Extract<RepoResult, { kind: "status" }>["entries"][number];
export type ChangeScope = "staged" | "unstaged" | "untracked";
export type ChangeMutation = "stage" | "unstage" | "discard";

export interface ChangeTarget {
  client: RepositoryClient;
  machine: string;
  paneId: string;
  root: string;
  workdir: string;
  path: string;
  scope: ChangeScope;
  entries: ChangeEntry[];
}

export function changePath(root: string, path: string): string {
  return `${root.replace(/\/$/, "")}/${path}`;
}

function preflight(target: ChangeTarget, action: ChangeMutation, entries: ChangeEntry[]) {
  if (machineId() !== target.machine || target.client.status !== "connected")
    throw new Error("Connection or machine changed. Refresh Changes before trying again.");
  const capabilities = useConnectionStore.getState().capabilities;
  if (isReadOnly(capabilities) || (capabilities && capabilities.files !== "write"))
    throw new Error("File changes are not allowed for this connection.");
  if (action === "unstage") return;
  for (const entry of entries) {
    for (const name of [entry.path, entry.originalPath].filter((path): path is string => !!path)) {
      const path = changePath(target.root, name);
      if (
        draftProtected(useFileDrafts.getState().drafts[draftKey(target.machine, path)]) ||
        useFileStore.getState().editorFile === path
      )
        throw new Error("Save or close open editors before changing these files.");
    }
  }
}

/** Preflight batch, then send one file at a time. Stop on first uncertainty. */
export async function mutateChanges(
  target: ChangeTarget,
  action: ChangeMutation,
  signal: AbortSignal,
  onProgress: (completed: number) => void,
): Promise<void> {
  if (signal.aborted) throw new DOMException("Request cancelled", "AbortError");
  preflight(target, action, target.entries);
  let completed = 0;
  for (const entry of target.entries) {
    if (signal.aborted) throw new DOMException("Request cancelled", "AbortError");
    preflight(target, action, [entry]);
    const result = await repositoryRequest(
      target.client,
      { id: target.paneId, action, path: target.root, file: entry.path, scope: target.scope },
      signal,
    );
    if (result.kind !== "status" || result.root !== target.root)
      throw new Error("Unexpected Git result. Refresh Changes before trying again.");
    completed += 1;
    onProgress(completed);
    if (!signal.aborted && machineId() === target.machine) {
      useRepoWatchStore.getState().applyChange({
        type: "repo:changed",
        root: target.root,
        git: true,
        refs: false,
        paths: [entry.path, ...(entry.originalPath ? [entry.originalPath] : [])],
        truncated: false,
      });
    }
  }
}
