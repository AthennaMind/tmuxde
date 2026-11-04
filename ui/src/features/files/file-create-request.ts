import { fileOperation } from "./file-operation";
import type { RepositoryClient } from "@/features/repository/repository-request";

export type CreateKind = "file" | "folder";

export function newEntryPath(directory: string, name: string): string {
  // oxlint-disable-next-line no-control-regex
  if (!name.trim() || name === "." || name === ".." || /[/\x00-\x1f\x7f]/.test(name)) {
    throw new Error("Enter a name without slashes or control characters.");
  }
  return `${directory.replace(/\/$/, "")}/${name}`;
}

export function createFileEntry(
  client: RepositoryClient,
  path: string,
  kind: CreateKind,
  signal: AbortSignal,
): Promise<void> {
  return fileOperation(
    client,
    { type: kind === "file" ? "file:create" : "file:mkdir", path },
    signal,
  );
}
