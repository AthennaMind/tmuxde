import { useEffect, useRef, useState } from "react";
import { ImagePlus } from "lucide-react";
import { cn } from "@repo/ui/lib/utils";
import { useConnectionStore } from "@/stores/connection-store";
import { useSessionStore } from "@/stores/session-store";
import { useBelievedInCopyMode } from "@/hooks/use-copy-mode";
import { usePhotoHistory } from "@/hooks/use-photo-history";
import { PhotoThumbnail } from "@/components/terminal/photo-thumbnail";
import {
  canUploadPhotos,
  insertPhoto,
  usePhotoUploads,
} from "@/lib/photo-insert";

export function PhotoUpload({
  className,
  labelClassName,
  compact = false,
}: {
  className?: string;
  /** Lets a narrow toolbar hide the visible label. */
  labelClassName?: string;
  compact?: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  const mounted = useRef(true);
  // Shared with paste, so a pasted screenshot shows progress here too.
  const uploading = usePhotoUploads((s) => s.pending > 0);
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

  if (!canUploadPhotos({ features, defaultPath: directory, capabilities }))
    return null;

  const upload = async (file: File) => {
    if (mounted.current) setSavedPath(null);
    const result = await insertPhoto(file);
    // Not inserted means the terminal changed mid-upload. Keep the path
    // where it can be copied.
    if (result && !result.inserted && mounted.current)
      setSavedPath(result.path);
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
        title={
          inCopyMode ? "Leave copy mode to upload a photo" : "Upload photo"
        }
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
        <span className={labelClassName}>
          {uploading ? (compact ? "…" : "Uploading…") : "Photo"}
        </span>
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
