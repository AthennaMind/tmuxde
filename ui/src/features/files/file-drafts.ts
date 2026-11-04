import { create } from "zustand";
import type { FileDocument } from "@/protocol";
import type { RepositoryClient } from "@/features/repository/repository-request";
import { onDisconnectAll } from "@/features/connection/relay-registry";
import { fileEditRequest } from "./file-edit-request";

export interface FileDraft {
  key: string;
  modelKey: string;
  moving: boolean;
  machine: string;
  path: string;
  content: string;
  base: FileDocument | null;
  conflict: FileDocument | null;
  error: string | null;
  online: boolean;
  checking: boolean;
  saving: boolean;
  needsCheck: boolean;
  paused: boolean;
  /** Last transmitted content, retained if its acknowledgement is lost. */
  pending: string | null;
  /** Changes only when disk content replaces the editor text. */
  revision: number;
  editedAt: number;
  operation: number;
}

interface DraftStore {
  drafts: Record<string, FileDraft>;
}

export const useFileDrafts = create<DraftStore>(() => ({ drafts: {} }));
let operation = 0;

export function draftKey(machine: string | undefined, path: string): string {
  return JSON.stringify([machine ?? "local", path]);
}

export function draftModified(draft: FileDraft | undefined): boolean {
  return !!draft?.base && draft.content !== draft.base.content;
}

export function draftProtected(draft: FileDraft | undefined): boolean {
  return draftModified(draft) || !!draft?.saving || !!draft?.moving || draft?.pending != null;
}

function update(key: string, change: (draft: FileDraft) => FileDraft): void {
  useFileDrafts.setState((state) => {
    const draft = state.drafts[key];
    if (!draft) return state;
    return { drafts: { ...state.drafts, [key]: change(draft) } };
  });
}

export function openDraft(machine: string | undefined, path: string): void {
  const key = draftKey(machine, path);
  if (useFileDrafts.getState().drafts[key]) return;
  useFileDrafts.setState((state) => ({
    drafts: {
      ...state.drafts,
      [key]: {
        key,
        modelKey: `${key}:${++operation}`,
        moving: false,
        machine: machine ?? "local",
        path,
        content: "",
        base: null,
        conflict: null,
        error: null,
        online: false,
        checking: false,
        saving: false,
        needsCheck: true,
        paused: false,
        pending: null,
        revision: 0,
        editedAt: 0,
        operation: ++operation,
      },
    },
  }));
}

export function closeDraft(key: string): void {
  useFileDrafts.setState((state) => {
    const drafts = { ...state.drafts };
    delete drafts[key];
    return { drafts };
  });
}

export function editDraft(key: string, content: string): void {
  update(key, (draft) => ({
    ...draft,
    content,
    editedAt: Date.now(),
    paused: draft.online && !draft.needsCheck ? false : draft.paused,
  }));
}

export function setDraftOnline(key: string, online: boolean): void {
  update(key, (draft) => {
    if (draft.online === online) return draft;
    return {
      ...draft,
      online,
      needsCheck: true,
      checking: false,
      saving: false,
      operation: ++operation,
      paused: draft.paused || draftProtected(draft),
    };
  });
}

function received(draft: FileDraft, document: FileDocument): FileDraft {
  const next = { ...draft, checking: false, needsCheck: false, error: null };
  // A reconnect may confirm a save whose acknowledgement was lost. Keep any
  // typing that came after that save, but do not replay the write.
  if (draft.pending !== null && document.content === draft.pending) {
    return { ...next, base: document, pending: null, conflict: null };
  }
  if (!draft.base || !draftModified(draft) || draft.content === document.content) {
    return {
      ...next,
      base: document,
      content: document.content,
      conflict: null,
      pending: null,
      revision: draft.content === document.content ? draft.revision : draft.revision + 1,
    };
  }
  if (document.revision === draft.base.revision) {
    return { ...next, base: document, conflict: null, pending: null };
  }
  return { ...next, conflict: document, paused: true, pending: null };
}

export async function checkDraft(key: string, client: RepositoryClient): Promise<void> {
  const draft = useFileDrafts.getState().drafts[key];
  if (
    !draft?.online ||
    draft.moving ||
    draft.checking ||
    draft.saving ||
    client.status !== "connected"
  )
    return;
  const id = ++operation;
  update(key, (current) => ({ ...current, checking: true, operation: id }));
  try {
    const result = await fileEditRequest(client, { type: "file:edit:read", path: draft.path });
    update(key, (current) => {
      if (current.operation !== id) return current;
      if (result.status === "error") {
        return { ...current, checking: false, error: result.error, needsCheck: true, paused: true };
      }
      return received(current, result.document);
    });
  } catch (error) {
    update(key, (current) =>
      current.operation !== id
        ? current
        : {
            ...current,
            checking: false,
            needsCheck: true,
            paused: true,
            error: error instanceof Error ? error.message : "Could not read file.",
          },
    );
  }
}

export async function saveDraft(
  key: string,
  client: RepositoryClient,
  resolveConflict = false,
): Promise<void> {
  const draft = useFileDrafts.getState().drafts[key];
  if (
    !draft?.base ||
    !draft.online ||
    draft.moving ||
    draft.needsCheck ||
    draft.saving ||
    draft.checking ||
    client.status !== "connected"
  )
    return;
  const base = resolveConflict ? draft.conflict : draft.base;
  if (!base?.writable || (draft.conflict && !resolveConflict) || !draftModified(draft)) return;
  const id = ++operation;
  update(key, (current) => ({
    ...current,
    saving: true,
    pending: draft.content,
    error: null,
    operation: id,
  }));
  try {
    const result = await fileEditRequest(client, {
      type: "file:edit:save",
      path: draft.path,
      content: draft.content,
      revision: base.revision,
    });
    update(key, (current) => {
      if (current.operation !== id) return current;
      if (result.status === "error") {
        return {
          ...current,
          saving: false,
          pending: null,
          error: result.error,
          paused: true,
          needsCheck: true,
        };
      }
      if (result.status === "conflict") {
        return {
          ...current,
          saving: false,
          pending: null,
          conflict: result.document,
          paused: true,
        };
      }
      return {
        ...current,
        saving: false,
        pending: null,
        base: result.document,
        conflict: null,
        paused: false,
      };
    });
  } catch (error) {
    update(key, (current) =>
      current.operation !== id
        ? current
        : {
            ...current,
            saving: false,
            needsCheck: true,
            paused: true,
            error: error instanceof Error ? error.message : "Save was not confirmed. Recheck file.",
          },
    );
  }
}

export function acceptDiskVersion(key: string): void {
  update(key, (draft) => {
    if (!draft.conflict || draft.moving || draft.saving || draft.checking) return draft;
    return {
      ...draft,
      content: draft.conflict.content,
      base: draft.conflict,
      conflict: null,
      pending: null,
      paused: false,
      error: null,
      revision: draft.revision + 1,
    };
  });
}

export function pathWithin(path: string, parent: string): boolean {
  return path === parent || path.startsWith(`${parent.replace(/\/$/, "")}/`);
}

/** Keep text and editor model identity while file paths change. */
export function prepareDraftMove(
  machine: string,
  from: string,
  to: string,
): (moved: boolean) => void {
  const affected = Object.values(useFileDrafts.getState().drafts).filter(
    (draft) => draft.machine === machine && pathWithin(draft.path, from),
  );
  if (affected.some((draft) => draft.saving || draft.pending !== null || draft.moving)) {
    throw new Error("Wait for file saves to finish before moving.");
  }
  const destination = Object.values(useFileDrafts.getState().drafts).some(
    (draft) => draft.machine === machine && pathWithin(draft.path, to),
  );
  if (destination) throw new Error("Close destination file tabs before moving here.");
  for (const draft of affected) {
    update(draft.key, (current) => ({
      ...current,
      moving: true,
      checking: false,
      operation: ++operation,
    }));
  }
  return (moved) => {
    useFileDrafts.setState((state) => {
      const drafts = { ...state.drafts };
      // A folder can gain open file tabs while its move is awaiting a reply.
      const current = moved
        ? Object.values(drafts).filter(
            (draft) => draft.machine === machine && pathWithin(draft.path, from),
          )
        : affected;
      for (const original of current) {
        const draft = drafts[original.key];
        if (!draft || draft.modelKey !== original.modelKey) continue;
        const path = moved ? to + draft.path.slice(from.length) : draft.path;
        const key = draftKey(machine, path);
        delete drafts[original.key];
        drafts[key] = {
          ...draft,
          path,
          key,
          moving: false,
          saving: false,
          checking: false,
          needsCheck: true,
          operation: ++operation,
        };
      }
      return { drafts };
    });
  };
}

// Draft contents are memory-only. Lock and sign-out erase them with sockets.
onDisconnectAll(() => useFileDrafts.setState({ drafts: {} }));
