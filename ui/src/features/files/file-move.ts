import type { RepositoryClient } from "@/features/repository/repository-request";
import { fileTabId, useMainTabsStore } from "@/features/workspace/main-tabs-store";
import { pathWithin, prepareDraftMove } from "./file-drafts";
import { fileOperation } from "./file-operation";
import { useFileStore } from "./file-store";

/** Paths come from machine listings or an absolute destination typed by user. */
export function moveDestination(from: string, directory: string): string {
  if (
    !directory.startsWith("/") ||
    directory.split("/").some((part) => part === "." || part === "..")
  ) {
    throw new Error("Choose an absolute folder path without . or .. segments.");
  }
  const folder = `/${directory.split("/").filter(Boolean).join("/")}`.replace(/\/$/, "");
  const to = `${folder}/${from.split("/").pop()}`;
  if (from === to) throw new Error("Already in this folder.");
  if (pathWithin(folder || "/", from)) throw new Error("Cannot move a folder into itself.");
  return to;
}

export async function moveFileEntry(
  client: RepositoryClient,
  machine: string,
  from: string,
  directory: string,
  signal: AbortSignal,
): Promise<string> {
  const to = moveDestination(from, directory);
  return renameFileEntry(client, machine, from, to, signal);
}

export async function renameFileEntry(
  client: RepositoryClient,
  machine: string,
  from: string,
  to: string,
  signal: AbortSignal,
): Promise<string> {
  if (from === to) throw new Error("Name has not changed.");
  if (
    Object.values(useMainTabsStore.getState().tabs).some(
      (tab) =>
        tab.kind === "file" &&
        !tab.scope &&
        (tab.machineId ?? "local") === machine &&
        pathWithin(tab.path, to),
    )
  )
    throw new Error("Close destination file tabs before moving here.");
  // Overlay editor uses an older unconditional save protocol.
  const overlay = useFileStore.getState().editorFile;
  if (overlay && pathWithin(overlay, from))
    throw new Error("Close overlay editor before moving this file.");
  const finish = prepareDraftMove(machine, from, to);
  let moved = false;
  try {
    await fileOperation(
      client,
      { type: "file:rename", oldPath: from, newPath: to, noReplace: true },
      signal,
    );
    moved = true;
    finish(true);
    useMainTabsStore.setState((state) => {
      const ids = new Map<string, string>();
      const tabs = state.tabs.map((tab) => {
        if (
          tab.kind !== "file" ||
          tab.scope ||
          (tab.machineId ?? "local") !== machine ||
          !pathWithin(tab.path, from)
        )
          return tab;
        const next = { ...tab, path: to + tab.path.slice(from.length) };
        next.id = fileTabId(next);
        ids.set(tab.id, next.id);
        return next;
      });
      return {
        tabs,
        active: ids.get(state.active) ?? state.active,
        order: state.order.map((id) => ids.get(id) ?? id),
      };
    });
    return to;
  } finally {
    if (!moved) finish(false);
  }
}
