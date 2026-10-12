import { useEffect, useRef, useState } from "react";
import { Images } from "lucide-react";
import { cn } from "@repo/ui/lib/utils";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@repo/ui/components/ui/dialog";
import { getRelayClient } from "@/hooks/use-websocket";
import { usePhotoHistory } from "@/hooks/use-photo-history";
import { useBelievedInCopyMode } from "@/hooks/use-copy-mode";
import { useConnectionStore } from "@/stores/connection-store";
import { useSessionStore } from "@/stores/session-store";
import { usePaneStore } from "@/stores/pane-store";
import { useAlertStore } from "@/stores/alert-store";
import { fetchFileObjectUrl, filesAvailable } from "@/lib/file-url";
import { reusePhotoPath } from "@/lib/photo-history.js";
import { believedInCopyMode } from "@/lib/copy-mode-belief";
import { useTerminalInput } from "@/lib/terminal-input.js";
import { getTerminalHandle } from "@/components/terminal/terminal-handle";
import { PhotoThumbnail } from "@/components/terminal/photo-thumbnail";

/**
 * Saved photos with a Reuse button each. Lives in the mobile dialog and in the
 * desktop sidebar Photos view.
 */
export function RecentPhotoList({
  onReused,
  className,
}: {
  onReused?: () => void;
  className?: string;
}) {
  const { client, paths, scope } = usePhotoHistory();
  const status = useConnectionStore((s) => s.status);
  const capabilities = useConnectionStore((s) => s.capabilities);
  const session = useSessionStore((s) => s.activeSessionId);
  const inCopyMode = useBelievedInCopyMode(session);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);

  useEffect(() => {
    setPending(null);
    setError(null);
    return () => controller.current?.abort();
  }, [client]);

  const canRead = capabilities?.files !== "none";
  const canReuse =
    status === "connected" &&
    !!session &&
    !capabilities?.readOnly &&
    canRead &&
    !inCopyMode;

  const reuse = async (path: string) => {
    if (!client || !canReuse || controller.current) return;
    const terminal = getTerminalHandle();
    if (!terminal) return;
    const pane = usePaneStore.getState().activePaneId;
    const abort = new AbortController();
    controller.current = abort;
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
    setPending(path);
    setError(null);
    try {
      await reusePhotoPath(path, {
        load: (savedPath) => fetchFileObjectUrl(savedPath, abort.signal),
        release: (url) => URL.revokeObjectURL(url),
        isCurrent: () => {
          const current = useConnectionStore.getState();
          return (
            !changed &&
            !abort.signal.aborted &&
            getRelayClient() === client &&
            client.status === "connected" &&
            getTerminalHandle() === terminal &&
            useSessionStore.getState().activeSessionId === session &&
            usePaneStore.getState().activePaneId === pane &&
            !current.capabilities?.readOnly &&
            current.capabilities?.files !== "none" &&
            !believedInCopyMode(session)
          );
        },
        resetInput: () => useTerminalInput.getState().reset(),
        paste: (text) => terminal.paste(text),
      });
      onReused?.();
      useAlertStore
        .getState()
        .push(
          "success",
          "Photo path inserted. Add your question, then press Enter.",
        );
    } catch (reason) {
      if (!abort.signal.aborted) {
        setError(
          reason instanceof Error
            ? reason.message
            : "Photo unavailable. Choose Photo to upload it again.",
        );
      }
    } finally {
      offSession();
      offPane();
      offStatus();
      controller.current = null;
      if (!abort.signal.aborted) setPending(null);
    }
  };

  return (
    <div className={cn("space-y-3", className)}>
      {!filesAvailable() && (
        <p className="text-sm text-muted-foreground">
          Connect directly to this machine to preview or reuse photos.
        </p>
      )}
      {inCopyMode && (
        <p className="text-sm text-muted-foreground">
          Leave copy mode to reuse a photo.
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {paths.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No photos yet. Upload or paste one and it shows up here.
        </p>
      ) : (
        <ul className="space-y-2">
          {paths.map((path) => (
            <li
              key={`${scope}:${path}`}
              className="flex items-center gap-3 rounded-md border border-border p-2"
            >
              <PhotoThumbnail path={path} className="h-14 w-14" />
              <span className="min-w-0 flex-1 break-all text-xs text-muted-foreground">
                {path}
              </span>
              <button
                type="button"
                disabled={!canReuse || !!pending || !filesAvailable()}
                aria-label={`Reuse photo ${path.split("/").pop()}`}
                className="min-h-9 shrink-0 rounded-md border border-border px-3 text-sm font-medium hover:bg-accent disabled:opacity-40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring pointer-coarse:min-h-11"
                onClick={() => void reuse(path)}
              >
                {pending === path ? "Checking…" : "Reuse"}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function RecentPhotos({
  className,
  labelClassName,
}: {
  className?: string;
  /** Lets a narrow toolbar hide the visible label. */
  labelClassName?: string;
}) {
  const { client, paths } = usePhotoHistory();
  const status = useConnectionStore((s) => s.status);
  const capabilities = useConnectionStore((s) => s.capabilities);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    setOpen(false);
  }, [client]);

  const canRead = capabilities?.files !== "none";

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button
          type="button"
          disabled={!paths.length || status !== "connected" || !canRead}
          title="Recent photos"
          className={cn(
            "flex min-h-11 items-center justify-center gap-1.5 rounded-md border border-border bg-background px-3 text-xs font-medium text-foreground disabled:opacity-40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
            className,
          )}
        >
          <Images className="h-4 w-4 shrink-0" aria-hidden />
          <span className={labelClassName}>
            Recent photos{paths.length > 0 ? ` (${paths.length})` : ""}
          </span>
        </button>
      </DialogTrigger>
      <DialogContent
        className="max-h-[80dvh] w-[calc(100%-2rem)] overflow-y-auto rounded-lg"
        onCloseAutoFocus={(event) => event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>Recent photos</DialogTitle>
          <DialogDescription>
            Reuse a photo saved on this machine. Its path is inserted without
            pressing Enter.
          </DialogDescription>
        </DialogHeader>
        {/* Unmounts on close, which aborts a reuse still in flight. */}
        <RecentPhotoList onReused={() => setOpen(false)} />
      </DialogContent>
    </Dialog>
  );
}
