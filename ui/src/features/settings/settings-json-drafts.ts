import { create } from "zustand";
import type { UserDocumentName } from "@/protocol";
import { useUserDocumentsStore } from "./user-documents-store";

/**
 * Unsaved text of the JSON settings tabs.
 *
 * Kept outside the tab, so a draft lives through a switch to another tab,
 * a machine switch and a closed tab. It goes with the page.
 */

export interface JsonDraft {
  text: string;
  /** Server text the draft started from. A newer server text means another browser saved. */
  base: string;
}

interface DraftsState {
  drafts: Partial<Record<UserDocumentName, JsonDraft>>;
}

export const useJsonDraftsStore = create<DraftsState>(() => ({ drafts: {} }));

export function setJsonDraft(name: UserDocumentName, draft: JsonDraft | null): void {
  useJsonDraftsStore.setState((state) => {
    const drafts = { ...state.drafts };
    if (draft) drafts[name] = draft;
    else delete drafts[name];
    return { drafts };
  });
}

/** The editor holds text the server does not have. */
export function hasUnsavedDraft(name: UserDocumentName): boolean {
  const draft = useJsonDraftsStore.getState().drafts[name];
  return !!draft && draft.text !== useUserDocumentsStore.getState().documents[name].text;
}

/** Draft after the editor text became `value`. Null when it matches the server text. */
export function nextDraft(
  previous: JsonDraft | undefined,
  value: string,
  stored: string,
): JsonDraft | null {
  if (value === stored) return null;
  // A draft that matched the server text was clean, so it starts from that text.
  const base = previous && previous.text !== stored ? previous.base : stored;
  return { text: value, base };
}

/** Draft after `saved` reached the server. Text typed during the save stays. */
export function draftAfterSave(previous: JsonDraft | undefined, saved: string): JsonDraft | null {
  return previous && previous.text !== saved ? { text: previous.text, base: saved } : null;
}
