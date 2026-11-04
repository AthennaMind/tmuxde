import type { RepositoryClient } from "@/features/repository/repository-request";
import { useMainTabsStore, TERMINAL_TAB } from "@/features/workspace/main-tabs-store";
import { draftKey, draftProtected, pathWithin, useFileDrafts } from "./file-drafts";
import { useFileStore } from "./file-store";
import { fileOperation } from "./file-operation";

/** Delete only after dialog confirmation. Unconfirmed requests keep tabs and drafts. */
export async function deleteFileEntry(
  client: RepositoryClient,
  machine: string,
  path: string,
  signal: AbortSignal,
): Promise<void> {
  if (
    Object.values(useFileDrafts.getState().drafts).some(
      (draft) => draft.machine === machine && pathWithin(draft.path, path) && draftProtected(draft),
    )
  )
    throw new Error(
      "Save or close unsaved files before deleting. Files may also be saving or moving.",
    );
  const overlay = useFileStore.getState().editorFile;
  if (overlay && pathWithin(overlay, path))
    throw new Error("Close overlay editor before deleting this file.");
  await fileOperation(client, { type: "file:delete", path }, signal);
  useMainTabsStore.setState((state) => {
    const tabs = state.tabs.filter((tab) => {
      if (
        tab.kind !== "file" ||
        tab.scope ||
        (tab.machineId ?? "local") !== machine ||
        !pathWithin(tab.path, path)
      )
        return true;
      // Edits made while deletion was pending stay available for recovery.
      return draftProtected(useFileDrafts.getState().drafts[draftKey(machine, tab.path)]);
    });
    const removed = new Set(state.tabs.filter((tab) => !tabs.includes(tab)).map((tab) => tab.id));
    return {
      tabs,
      order: state.order.filter((id) => !removed.has(id)),
      active: removed.has(state.active)
        ? (tabs[
            Math.min(
              state.tabs.findIndex((tab) => tab.id === state.active),
              tabs.length - 1,
            )
          ]?.id ?? TERMINAL_TAB)
        : state.active,
    };
  });
}
