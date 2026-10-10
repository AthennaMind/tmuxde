"use client";

import { useEffect, useRef, useState } from "react";
import { ImagePlus } from "lucide-react";
import { cn } from "@repo/ui/lib/utils";
import { getRelayClient } from "@/hooks/use-websocket";
import { useConnectionStore } from "@/stores/connection-store";
import { useSessionStore } from "@/stores/session-store";
import { usePaneStore } from "@/stores/pane-store";
import { useAlertStore } from "@/stores/alert-store";
import {
  preparePhoto,
  uploadPhoto,
  photoPathText,
} from "@/lib/photo-upload.js";
import { useTerminalInput } from "@/lib/terminal-input.js";
import { getTerminalHandle } from "@/components/terminal/terminal-handle";
import { useBelievedInCopyMode } from "@/hooks/use-copy-mode";
import { believedInCopyMode } from "@/lib/copy-mode-belief";
import { photoHistory } from "@/lib/photo-history.js";
import { usePhotoHistory } from "@/hooks/use-photo-history";
import { PhotoThumbnail } from "@/components/terminal/photo-thumbnail";

export function PhotoUpload({
  className,
  compact = false,
}: {
  className?: string;
  compact?: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  const mounted = useRef(true);
  const [uploading, setUploading] = useState(false);
  const [savedPath, setSavedPath] = useState<string | null>(null);
  const status = useConnectionStore((s) => s.status);
  const capabilities = useConnectionStore((s) => s.capabilities);
  const features = useConnectionStore((s) => s.features);
  const directory = useConnectionStore((s) => s.defaultPath);
  const session = useSessionStore((s) => s.activeSessionId);
  const inCopyMode = useBelievedInCopyMode(session);
  const { paths, scope } = usePhotoHistory();
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  if (
    !features.has("file:upload:ack") ||
    !directory ||
    capabilities?.readOnly ||
    (capabilities && capabilities.files !== "write")
  )
    return null;

  const upload = async (file: File) => {
    const client = getRelayClient();
    const terminal = getTerminalHandle();
    if (!client || client.status !== "connected" || !session || !terminal)
      return;
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
    setUploading(true);
    setSavedPath(null);
    try {
      const photo = await preparePhoto(file);
      if (changed || !mounted.current)
        throw new Error("Session changed. Choose photo again.");
      const path = await uploadPhoto(client, photo, directory);
      photoHistory.add(client, path);
      if (
        changed ||
        !mounted.current ||
        getRelayClient() !== client ||
        getTerminalHandle() !== terminal ||
        believedInCopyMode(session)
      ) {
        if (mounted.current) setSavedPath(path);
        useAlertStore
          .getState()
          .push(
            "info",
            `Photo saved: ${path}. Terminal changed, so path was not inserted.`,
          );
        return;
      }
      useTerminalInput.getState().reset();
      terminal.paste(photoPathText(path));
      useAlertStore
        .getState()
        .push(
          "success",
          "Photo path inserted. Add your question, then press Enter.",
        );
    } catch (error) {
      useAlertStore
        .getState()
        .push(
          "error",
          error instanceof Error ? error.message : "Photo upload failed",
        );
    } finally {
      offSession();
      offPane();
      offStatus();
      if (mounted.current) setUploading(false);
    }
  };

  return (
    <div
      className={cn(
        "flex shrink-0 items-center gap-2",
        compact && "relative min-w-0",
      )}
    >
      <input
        ref={input}
        type="file"
        accept="image/*"
        aria-label="Choose photo"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file && !uploading) void upload(file);
        }}
      />
      <button
        type="button"
        aria-label="Upload photo"
        aria-busy={uploading}
        disabled={uploading || status !== "connected" || !session || inCopyMode}
        title={inCopyMode ? "Leave copy mode to upload a photo" : undefined}
        className={cn(
          "flex h-11 shrink-0 items-center justify-center gap-1.5 rounded-md border border-border bg-background px-3 text-xs font-medium text-foreground disabled:opacity-40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
          compact && "w-full min-w-0 px-1",
          compact && paths[0] && "flex-col gap-0",
          className,
        )}
        onClick={() => input.current?.click()}
      >
        {paths[0] ? (
          <PhotoThumbnail
            key={`${scope}:${paths[0]}`}
            path={paths[0]}
            className={compact ? "h-4 w-4" : "h-5 w-5"}
          />
        ) : !compact ? (
          <ImagePlus className="h-4 w-4" aria-hidden />
        ) : null}
        {uploading ? (compact ? "…" : "Uploading…") : "Photo"}
      </button>
      {savedPath && (
        <input
          aria-label="Uploaded photo path"
          value={savedPath}
          readOnly
          className={cn(
            "w-48 min-w-0 rounded border border-border bg-background p-2 text-xs",
            compact && "absolute bottom-full right-0 z-10",
          )}
          onFocus={(e) => e.target.select()}
        />
      )}
    </div>
  );
}
