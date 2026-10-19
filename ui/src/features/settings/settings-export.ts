import type { UserDocumentName } from "@/protocol";
import { downloadText } from "@/shared/download-text";
import { useUserDocumentsStore } from "./user-documents-store";

/** File names of exported documents. Import tells them apart by content, not name. */
export const EXPORT_FILE_NAMES: Record<UserDocumentName, string> = {
  settings: "tmuxde-settings.json",
  keybindings: "tmuxde-keybindings.json",
};

export function exportFileName(name: UserDocumentName): string {
  return EXPORT_FILE_NAMES[name];
}

/**
 * Download a document's current text, exactly as the hub holds it. Offline
 * that is the cached copy, the same text the app applies.
 */
export function exportUserDocument(name: UserDocumentName): void {
  downloadText(exportFileName(name), useUserDocumentsStore.getState().documents[name].text);
}
