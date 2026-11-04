import { useEffect } from "react";
import { useConnectionStore } from "@/features/connection/connection-store";
import { get } from "@/features/connection/relay-registry";
import { useSettingsStore } from "@/features/settings/settings-store";
import {
  checkDraft,
  draftModified,
  draftProtected,
  saveDraft,
  setDraftOnline,
  useFileDrafts,
  type FileDraft,
} from "./file-drafts";

/** Lives above machine views so switching tabs cannot abandon a save. */
export function FileDraftSync() {
  const drafts = useFileDrafts((state) => state.drafts);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (!Object.values(useFileDrafts.getState().drafts).some(draftProtected)) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, []);
  return Object.values(drafts).map((draft) => <DraftSync key={draft.key} draft={draft} />);
}

function DraftSync({ draft }: { draft: FileDraft }) {
  const connection = useConnectionStore((state) => state.status);
  const autoSave = useSettingsStore((state) => state.autoSave);
  const capabilities = useConnectionStore((state) => state.capabilities);
  const client = get(draft.machine);
  useEffect(() => {
    setDraftOnline(draft.key, client?.status === "connected");
    if (!client) return;
    const check = () => {
      setDraftOnline(draft.key, client.status === "connected");
      if (client.status === "connected") void checkDraft(draft.key, client);
    };
    check();
    const unsubscribe = client.onStatusChange(check);
    // Polling also catches changes outside the selected repository or pane.
    const timer = setInterval(() => {
      if (useFileDrafts.getState().drafts[draft.key]?.base) void checkDraft(draft.key, client);
    }, 3_000);
    return () => {
      clearInterval(timer);
      unsubscribe();
      setDraftOnline(draft.key, false);
    };
  }, [draft.key, client, connection]);

  useEffect(() => {
    if (
      !client ||
      !autoSave ||
      capabilities?.readOnly ||
      (capabilities !== null && capabilities.files !== "write") ||
      !draftModified(draft) ||
      !draft.base?.writable ||
      !draft.online ||
      draft.paused ||
      draft.needsCheck ||
      draft.conflict ||
      draft.saving ||
      draft.checking
    )
      return;
    const timer = setTimeout(
      () => void saveDraft(draft.key, client),
      Math.max(0, 1_000 - (Date.now() - draft.editedAt)),
    );
    return () => clearTimeout(timer);
  }, [draft, client, autoSave, capabilities]);
  return null;
}
