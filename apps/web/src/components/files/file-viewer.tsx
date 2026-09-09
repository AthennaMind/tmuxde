"use client";

import { useEffect, useState } from "react";
import {
  X,
  Download,
  FileText,
  Film,
  Music,
  Archive,
  FileQuestion,
  Image as ImageIcon,
  FileType,
} from "lucide-react";
import { cn } from "@repo/ui/lib/utils";
import { Button } from "@repo/ui/components/ui/button";
import { Badge } from "@repo/ui/components/ui/badge";
import { MiniScrollbar } from "@repo/ui/components/ui/mini-scrollbar";
import { useFileStore } from "@/stores/file-store";
import { downloadFile, filesAvailable } from "@/lib/file-url";
import { useFileObjectUrl } from "@/hooks/use-file-object-url";
import {
  getFileViewMode,
  getFileCategory,
  formatFileSize,
  type FileViewMode,
} from "@/lib/file-utils";
import { getRelayClient } from "@/hooks/use-websocket";

const CATEGORY_ICONS: Record<string, typeof FileQuestion> = {
  image: ImageIcon,
  video: Film,
  audio: Music,
  archive: Archive,
  document: FileQuestion,
  font: FileType,
  binary: FileQuestion,
};

/**
 * A download link, or an explanation of why there isn't one.
 *
 * A tunnelled session has no HTTP route to the relay, so `/file` cannot be
 * fetched at all. Saying so beats rendering a link that silently 404s against
 * the web app's own origin.
 */
function DownloadLink({
  path,
  fileName,
  children,
}: {
  path: string;
  fileName: string;
  children: React.ReactNode;
}) {
  if (!filesAvailable()) {
    return (
      <p className="text-xs text-muted-foreground">
        Downloads need a direct connection to the machine — this session is
        going through the relay.
      </p>
    );
  }
  // A button rather than an `<a href>`: the token authenticates the whole
  // session, and a URL carrying it would be written to history and to every
  // access log on the way. `downloadFile` sends it as a header instead.
  return (
    <button
      type="button"
      onClick={() => {
        void downloadFile(path, fileName).catch(() => {});
      }}
    >
      {children}
    </button>
  );
}

function MediaError({ path, message }: { path: string; message: string }) {
  const fileName = path.split("/").pop() ?? "";
  return (
    <div className="flex flex-col items-center justify-center gap-3 p-8 text-muted-foreground">
      <FileQuestion className="h-12 w-12 opacity-40" />
      <p className="text-sm">{message}</p>
      <DownloadLink path={path} fileName={fileName}>
        <Button variant="secondary" size="sm">
          <Download className="mr-2 h-4 w-4" />
          Download Instead
        </Button>
      </DownloadLink>
    </div>
  );
}

function ImageContent({ path }: { path: string }) {
  const [actualSize, setActualSize] = useState(false);
  // "Actual size" on a large image scrolls in both axes, with no indication of
  // where in the image the view sits. One node, two bars — the hook keeps its
  // own node, so both axes have to read the same one from here.
  const [imageScrollRef, setImageScroller] = useState<HTMLElement | null>(null);
  const [decodeError, setDecodeError] = useState(false);
  const { url, loading, error } = useFileObjectUrl(path);

  if (error || decodeError) {
    return (
      <MediaError
        path={path}
        message="Failed to load image — the file may be missing or inaccessible."
      />
    );
  }

  return (
    <div className="relative h-full">
      <MiniScrollbar target={imageScrollRef} />
      <MiniScrollbar target={imageScrollRef} orientation="horizontal" />
      <div
        ref={setImageScroller}
        className="flex h-full items-center justify-center overflow-auto"
        style={{
          backgroundImage:
            "linear-gradient(45deg, hsl(var(--muted)) 25%, transparent 25%), linear-gradient(-45deg, hsl(var(--muted)) 25%, transparent 25%), linear-gradient(45deg, transparent 75%, hsl(var(--muted)) 75%), linear-gradient(-45deg, transparent 75%, hsl(var(--muted)) 75%)",
          backgroundSize: "20px 20px",
          backgroundPosition: "0 0, 0 10px, 10px -10px, -10px 0px",
        }}
      >
        <div className="relative">
          {(loading || !url) && (
            <div className="flex items-center justify-center p-8">
              <span className="text-sm text-muted-foreground">Loading...</span>
            </div>
          )}
          {url && (
            <>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={url}
                alt={path.split("/").pop() ?? ""}
                className={cn(actualSize ? "" : "max-w-full object-contain")}
                style={{
                  touchAction: "pinch-zoom",
                  ...(actualSize
                    ? {}
                    : { maxHeight: "calc(var(--vv-height, 100dvh) - 8rem)" }),
                }}
                onError={() => setDecodeError(true)}
              />
              <Button
                variant="secondary"
                size="sm"
                className="absolute bottom-3 right-3 opacity-80 hover:opacity-100"
                onClick={() => setActualSize(!actualSize)}
              >
                {actualSize ? "Fit to Screen" : "Actual Size"}
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function VideoContent({ path }: { path: string }) {
  const [decodeError, setDecodeError] = useState(false);
  const { url, loading, error } = useFileObjectUrl(path);

  if (error || decodeError) {
    return (
      <MediaError
        path={path}
        message="Failed to load video — the format may be unsupported or the file inaccessible."
      />
    );
  }

  return (
    <div className="flex h-full items-center justify-center">
      {url ? (
        <video
          src={url}
          controls
          preload="metadata"
          className="max-h-full max-w-full"
          onError={() => setDecodeError(true)}
        />
      ) : (
        loading && (
          <span className="text-sm text-muted-foreground">Loading...</span>
        )
      )}
    </div>
  );
}

function AudioContent({ path }: { path: string }) {
  const fileName = path.split("/").pop() ?? "";
  const [duration, setDuration] = useState<string | null>(null);
  const [decodeError, setDecodeError] = useState(false);
  const { url, error } = useFileObjectUrl(path);

  if (error || decodeError) {
    return (
      <MediaError
        path={path}
        message="Failed to load audio — the format may be unsupported or the file inaccessible."
      />
    );
  }

  return (
    <div className="flex h-full flex-col items-center justify-center gap-4">
      <Music className="h-20 w-20 text-muted-foreground opacity-40" />
      <p className="text-sm font-medium">{fileName}</p>
      {duration && <p className="text-xs text-muted-foreground">{duration}</p>}
      <audio
        src={url ?? undefined}
        controls
        preload="metadata"
        className="w-full max-w-md"
        onError={() => setDecodeError(true)}
        onLoadedMetadata={(e) => {
          const secs = (e.target as HTMLAudioElement).duration;
          if (Number.isFinite(secs)) {
            const m = Math.floor(secs / 60);
            const s = Math.floor(secs % 60);
            setDuration(`${m}:${s.toString().padStart(2, "0")}`);
          }
        }}
      />
    </div>
  );
}

function PdfContent({ path }: { path: string }) {
  const { url, loading, error } = useFileObjectUrl(path);

  if (error) {
    return (
      <MediaError
        path={path}
        message="Failed to load PDF — try downloading it instead."
      />
    );
  }

  if (!url) {
    return (
      <div className="flex h-full items-center justify-center">
        {loading && (
          <span className="text-sm text-muted-foreground">Loading...</span>
        )}
      </div>
    );
  }

  return (
    <iframe
      src={url}
      className="h-full w-full border-0"
      title={path.split("/").pop() ?? "PDF"}
    />
  );
}

function BinaryContent({ path, size }: { path: string; size?: number }) {
  const fileName = path.split("/").pop() ?? "";
  const category = getFileCategory(path) ?? "binary";
  const Icon = CATEGORY_ICONS[category] ?? FileQuestion;

  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-muted-foreground">
      <Icon className="h-20 w-20 opacity-40" />
      <p className="text-sm font-medium text-foreground">{fileName}</p>
      <Badge variant="secondary" className="capitalize">
        {category}
      </Badge>
      {size != null && <p className="text-xs">{formatFileSize(size)}</p>}
      <DownloadLink path={path} fileName={fileName}>
        <Button variant="default" size="lg" className="mt-4">
          <Download className="mr-2 h-4 w-4" />
          Download
        </Button>
      </DownloadLink>
      <p className="mt-2 text-xs">
        This file type can&apos;t be previewed in the browser
      </p>
    </div>
  );
}

const VIEW_MODE_LABELS: Record<FileViewMode, string> = {
  text: "text",
  image: "image",
  video: "video",
  audio: "audio",
  pdf: "PDF",
  binary: "binary",
};

export function FileViewer() {
  const editorFile = useFileStore((s) => s.editorFile);
  const closeEditor = useFileStore((s) => s.closeEditor);
  const openEditorAsText = useFileStore((s) => s.openEditorAsText);
  const setFileStat = useFileStore((s) => s.setFileStat);
  const fileStat = useFileStore((s) => s.fileStat);

  useEffect(() => {
    if (!editorFile) return;
    const client = getRelayClient();
    if (!client) return;
    client.send({ type: "file:stat", path: editorFile });
    const unsub = client.onMessage((msg) => {
      if (msg.type === "file:stat" && msg.stat.path === editorFile) {
        setFileStat(msg.stat);
      }
    });
    return () => {
      unsub();
      setFileStat(null);
    };
  }, [editorFile, setFileStat]);

  if (!editorFile) return null;

  const fileName = editorFile.split("/").pop() ?? "";
  const viewMode = getFileViewMode(editorFile);

  return (
    // `fixed` escapes AppShell's frame, so this panel carries its own insets.
    <div className="fixed inset-0 z-[var(--z-panel)] flex flex-col bg-background pb-[env(safe-area-inset-bottom)] pt-[env(safe-area-inset-top)]">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
        <span className="min-w-0 flex-1 truncate text-sm font-medium">
          {fileName}
        </span>
        <Badge variant="secondary" className="text-[10px]">
          {VIEW_MODE_LABELS[viewMode]}
        </Badge>
        <DownloadLink path={editorFile} fileName={fileName}>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            title="Download"
          >
            <Download className="h-4 w-4" />
          </Button>
        </DownloadLink>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          title="Open as Text"
          onClick={() => openEditorAsText(editorFile)}
        >
          <FileText className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          title="Close"
          onClick={closeEditor}
        >
          <X className="h-4 w-4" />
        </Button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-hidden">
        {viewMode === "image" && <ImageContent path={editorFile} />}
        {viewMode === "video" && <VideoContent path={editorFile} />}
        {viewMode === "audio" && <AudioContent path={editorFile} />}
        {viewMode === "pdf" && <PdfContent path={editorFile} />}
        {viewMode === "binary" && (
          <BinaryContent path={editorFile} size={fileStat?.size} />
        )}
      </div>

      {/* Status bar */}
      {fileStat && (
        <div className="flex items-center gap-3 border-t px-3 py-1 text-[10px] text-muted-foreground">
          <span>{formatFileSize(fileStat.size)}</span>
          <span>{fileStat.permissions}</span>
          <span>{new Date(fileStat.modified).toLocaleString()}</span>
        </div>
      )}
    </div>
  );
}
