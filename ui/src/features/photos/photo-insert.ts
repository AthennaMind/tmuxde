import { create } from "zustand";
import { getRelayClient } from "@/features/connection/use-websocket";
import { useConnectionStore } from "@/features/connection/connection-store";
import { useSessionStore } from "@/features/session/session-store";
import { usePaneStore } from "@/features/panes/pane-store";
import { useAlertStore } from "@/shared/alert-store";
import { getTerminalHandle } from "@/features/terminal/terminal-handle";
import { believedInCopyMode } from "@/features/terminal/copy-mode-belief";
import { useTerminalInput } from "@/features/terminal/terminal-input";
import { photoHistory } from "./photo-history";
import { preparePhoto, uploadPhoto, photoPathText } from "./photo-upload-client";

/**
 * Uploads in flight, from the Photo button or a paste. Shared so the button
 * reads "Uploading…" whichever one started it.
 */
export const usePhotoUploads = create<{ pending: number }>(() => ({
  pending: 0,
}));

/** Whether this connection can take photos at all. */
export function canUploadPhotos(
  connection: Pick<
    ReturnType<typeof useConnectionStore.getState>,
    "features" | "defaultPath" | "capabilities"
  >,
): boolean {
  const { features, defaultPath, capabilities } = connection;
  return (
    features.has("file:upload:ack") &&
    !!defaultPath &&
    !capabilities?.readOnly &&
    (!capabilities || capabilities.files === "write")
  );
}

/** Why a photo cannot go into the terminal right now, or null when it can. */
export function photoInsertBlocker(): string | null {
  const connection = useConnectionStore.getState();
  if (!canUploadPhotos(connection)) return "This connection cannot upload photos";
  if (connection.status !== "connected") return "Not connected";
  const session = useSessionStore.getState().activeSessionId;
  if (!session || !getTerminalHandle()) return "Open a session first";
  if (believedInCopyMode(session)) return "Leave copy mode to add a photo";
  return null;
}

export type PhotoInsertResult = { path: string; inserted: boolean };

/**
 * Upload a photo and type its path at the prompt, without pressing Enter.
 *
 * The path goes in only if the terminal is still the one the upload started
 * from. A switch of session, pane or connection mid-upload leaves the photo
 * saved and says where. Feedback goes through alerts, so callers only need the
 * result for their own UI.
 */
export async function insertPhoto(file: File): Promise<PhotoInsertResult | null> {
  const client = getRelayClient();
  const terminal = getTerminalHandle();
  const session = useSessionStore.getState().activeSessionId;
  const directory = useConnectionStore.getState().defaultPath;
  if (!client || client.status !== "connected" || !session || !terminal || !directory) return null;

  const pane = usePaneStore.getState().activePaneId;
  let changed = false;
  const offSession = useSessionStore.subscribe((s) => {
    if (s.activeSessionId !== session) changed = true;
  });
  const offPane = usePaneStore.subscribe((s) => {
    if (s.activePaneId !== pane) changed = true;
  });
  const offStatus = client.onStatusChange((s) => {
    if (s !== "connected") changed = true;
  });
  const alerts = useAlertStore.getState();
  usePhotoUploads.setState((s) => ({ pending: s.pending + 1 }));
  try {
    const photo = await preparePhoto(file);
    if (changed) throw new Error("Session changed. Choose photo again.");
    const path = await uploadPhoto(client, photo, directory);
    photoHistory.add(client, path);
    if (
      changed ||
      getRelayClient() !== client ||
      getTerminalHandle() !== terminal ||
      believedInCopyMode(session)
    ) {
      alerts.push("info", `Photo saved: ${path}. Terminal changed, so path was not inserted.`);
      return { path, inserted: false };
    }
    useTerminalInput.getState().reset();
    terminal.paste(photoPathText(path));
    alerts.push("success", "Photo path inserted. Add your question, then press Enter.");
    return { path, inserted: true };
  } catch (error) {
    alerts.push("error", error instanceof Error ? error.message : "Photo upload failed");
    return null;
  } finally {
    offSession();
    offPane();
    offStatus();
    usePhotoUploads.setState((s) => ({ pending: s.pending - 1 }));
  }
}
