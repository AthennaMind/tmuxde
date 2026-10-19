import { useEffect, useId, useRef, useState, type SyntheticEvent } from "react";
import {
  Archive,
  Database,
  Download,
  FileQuestion,
  FileText,
  FileType,
  Film,
  Image as ImageIcon,
  Music,
  type LucideIcon,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Notice } from "@/shared/notice";
import { cn } from "@/shared/utils";
import { filesAvailable } from "./file-url";
import { formatFileSize, getFileCategory, previewLimit, type FileViewMode } from "./file-utils";
import { startDownload } from "./transfer-store";
import { useFileObjectUrl } from "./use-file-object-url";
import { useFileStreamUrl } from "./use-file-stream-url";

type PreviewMode = Exclude<FileViewMode, "text" | "binary">;

const KIND_NOUNS: Record<PreviewMode, string> = {
  image: "image",
  video: "video",
  audio: "audio file",
  pdf: "PDF",
  font: "font",
};

const CATEGORY_ICONS: Record<string, LucideIcon> = {
  image: ImageIcon,
  video: Film,
  audio: Music,
  archive: Archive,
  document: FileText,
  font: FileType,
  database: Database,
  binary: FileQuestion,
};

function baseName(path: string): string {
  return path.split("/").pop() ?? "";
}

interface MediaPreviewProps {
  path: string;
  mode: Exclude<FileViewMode, "text">;
  /** Unknown for a file opened from a Markdown link. */
  size?: number;
  /** The tree listed this path as a symbolic link. */
  symlink?: boolean;
  /** Machine the path lives on. The active route by default. */
  target?: string;
}

/**
 * A file the browser shows by itself: image, video, audio, PDF or font.
 * Anything else gets a card with its size and a download button.
 *
 * Images and fonts arrive as a blob fetched with the bearer header. Video,
 * audio and PDF load straight from `/file` with a ticket, so a long video
 * plays and seeks before the whole file is down.
 */
export function MediaPreview({ path, mode, size, symlink = false, target }: MediaPreviewProps) {
  if (mode === "binary") return <BinaryPreview path={path} size={size} target={target} />;
  if (symlink) return <Notice>Preview is unavailable for symbolic links.</Notice>;
  if (!filesAvailable()) return <Notice>Preview needs a direct connection to this machine.</Notice>;
  return (
    <LoadGate key={path} path={path} mode={mode} size={size} target={target}>
      {mode === "image" && <ImagePreview path={path} target={target} />}
      {mode === "video" && <VideoPreview path={path} target={target} />}
      {mode === "audio" && <AudioPreview path={path} target={target} />}
      {mode === "pdf" && <PdfPreview path={path} target={target} />}
      {mode === "font" && <FontPreview path={path} target={target} />}
    </LoadGate>
  );
}

/** A file above the preview limit waits for a click that names its size. */
function LoadGate({
  path,
  mode,
  size,
  target,
  children,
}: {
  path: string;
  mode: PreviewMode;
  size?: number;
  target?: string;
  children: React.ReactNode;
}) {
  const [confirmed, setConfirmed] = useState(false);
  const limit = previewLimit(mode);
  if (confirmed || !limit || size === undefined || size <= limit) return children;
  const noun = KIND_NOUNS[mode];
  return (
    <div className="flex flex-col items-start gap-3 px-4 py-6">
      <p role="status" className="text-sm leading-relaxed text-muted-foreground">
        {`This ${noun} is ${formatFileSize(size)}. The preview downloads the whole file first.`}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" size="sm" onClick={() => setConfirmed(true)}>
          {`Load ${noun}`}
        </Button>
        <DownloadAction path={path} target={target} variant="ghost" />
      </div>
    </div>
  );
}

function DownloadAction({
  path,
  target,
  variant = "secondary",
}: {
  path: string;
  target?: string;
  variant?: "default" | "secondary" | "ghost";
}) {
  return (
    <Button variant={variant} size="sm" onClick={() => startDownload(path, target)}>
      <Download className="me-2 h-4 w-4" aria-hidden />
      Download
    </Button>
  );
}

/** What went wrong, and the download as the way out. */
function PreviewFailure({
  path,
  target,
  children,
}: {
  path: string;
  target?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-start gap-3 px-4 py-6">
      <p role="alert" className="text-sm leading-relaxed text-destructive">
        {children}
      </p>
      <DownloadAction path={path} target={target} />
    </div>
  );
}

function ImagePreview({ path, target }: { path: string; target?: string }) {
  const [actualSize, setActualSize] = useState(false);
  const [decodeError, setDecodeError] = useState(false);
  const { url, loading, error } = useFileObjectUrl(path, target);
  if (error || decodeError)
    return (
      <PreviewFailure path={path} target={target}>
        Unable to show this image. The file may be missing, or in a format this browser does not
        decode.
      </PreviewFailure>
    );
  if (loading || !url) return <Notice>Loading image...</Notice>;
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {/* Auto margins center a small image and let a big one scroll from its
          first pixel, which flex centering would cut off. */}
      <div className="flex min-h-0 flex-1 overflow-auto bg-checkerboard p-4">
        <img
          src={url}
          alt={baseName(path)}
          className={cn(
            "m-auto",
            actualSize ? "max-w-none" : "max-h-full max-w-full object-contain",
          )}
          onError={() => setDecodeError(true)}
        />
      </div>
      <Button
        variant="secondary"
        size="sm"
        className="absolute bottom-3 end-3 aria-pressed:bg-accent aria-pressed:text-accent-foreground"
        aria-pressed={actualSize}
        onClick={() => setActualSize(!actualSize)}
      >
        Actual size
      </Button>
    </div>
  );
}

/**
 * The ticket URL of a media element, with one recovery. A ticket that ran
 * out during playback fails the next range request, and the element
 * reports an error. The first error after a successful load asks for a
 * new ticket and restores the position. A second error in a row is a
 * format the browser does not play.
 */
function useStreamedMedia(path: string, target?: string) {
  const stream = useFileStreamUrl(path, target);
  const [failed, setFailed] = useState(false);
  const recovering = useRef(false);
  const resume = useRef<{ time: number; playing: boolean } | null>(null);
  const onError = (event: SyntheticEvent<HTMLMediaElement>) => {
    if (recovering.current) {
      setFailed(true);
      return;
    }
    const media = event.currentTarget;
    recovering.current = true;
    resume.current = { time: media.currentTime, playing: !media.paused };
    stream.refresh();
  };
  const onLoadedMetadata = (event: SyntheticEvent<HTMLMediaElement>) => {
    const at = resume.current;
    resume.current = null;
    if (!at) return;
    const media = event.currentTarget;
    media.currentTime = at.time;
    if (at.playing) void media.play().catch(() => {});
  };
  const onLoadedData = () => {
    recovering.current = false;
  };
  return { ...stream, failed, onError, onLoadedMetadata, onLoadedData };
}

function VideoPreview({ path, target }: { path: string; target?: string }) {
  const media = useStreamedMedia(path, target);
  if (media.error || media.failed)
    return (
      <PreviewFailure path={path} target={target}>
        Unable to play this video. This browser may not support its codec. Download it to play it in
        another app.
      </PreviewFailure>
    );
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center bg-surface-sunken p-4">
      <video
        src={media.url ?? undefined}
        controls
        playsInline
        preload="metadata"
        aria-label={baseName(path)}
        className="max-h-full max-w-full rounded-md"
        onError={media.onError}
        onLoadedMetadata={media.onLoadedMetadata}
        onLoadedData={media.onLoadedData}
      />
    </div>
  );
}

function formatDuration(seconds: number): string | null {
  if (!Number.isFinite(seconds)) return null;
  const whole = Math.floor(seconds);
  const s = (whole % 60).toString().padStart(2, "0");
  const m = Math.floor(whole / 60) % 60;
  const h = Math.floor(whole / 3600);
  return h ? `${h}:${m.toString().padStart(2, "0")}:${s}` : `${m}:${s}`;
}

function AudioPreview({ path, target }: { path: string; target?: string }) {
  const media = useStreamedMedia(path, target);
  const [duration, setDuration] = useState<string | null>(null);
  if (media.error || media.failed)
    return (
      <PreviewFailure path={path} target={target}>
        Unable to play this audio file. This browser may not support its codec. Download it to play
        it in another app.
      </PreviewFailure>
    );
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6">
      <Music aria-hidden className="h-12 w-12 text-muted-foreground opacity-40" strokeWidth={1.5} />
      <p className="max-w-full break-all text-center text-sm font-medium">{baseName(path)}</p>
      {duration && <p className="text-xs tabular-nums text-muted-foreground">{duration}</p>}
      <audio
        src={media.url ?? undefined}
        controls
        preload="metadata"
        aria-label={baseName(path)}
        className="w-full max-w-md"
        onError={media.onError}
        onLoadedData={media.onLoadedData}
        onLoadedMetadata={(event) => {
          media.onLoadedMetadata(event);
          setDuration(formatDuration(event.currentTarget.duration));
        }}
      />
    </div>
  );
}

/** Whether this browser shows a PDF inside the page. Unknown counts as yes. */
function browserShowsPdf(): boolean {
  return typeof navigator === "undefined" || navigator.pdfViewerEnabled !== false;
}

function PdfPreview({ path, target }: { path: string; target?: string }) {
  const { url, loading, error } = useFileStreamUrl(path, target);
  if (error)
    return (
      <PreviewFailure path={path} target={target}>
        Unable to open this PDF. Download it to open it in another app.
      </PreviewFailure>
    );
  if (!browserShowsPdf())
    return (
      <BinaryPreview
        path={path}
        target={target}
        note="This browser has no PDF viewer. Download the file to open it in another app."
      />
    );
  if (loading || !url) return <Notice>Loading PDF...</Notice>;
  return (
    <iframe
      src={url}
      title={baseName(path)}
      className="min-h-0 flex-1 border-0 bg-surface-sunken"
    />
  );
}

const FONT_SAMPLE = "The quick brown fox jumps over the lazy dog";
const FONT_GLYPHS =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZ abcdefghijklmnopqrstuvwxyz 0123456789 .,;:!?&@#%()[]{}";

function FontPreview({ path, target }: { path: string; target?: string }) {
  const { url, loading, error } = useFileObjectUrl(path, target);
  const id = useId();
  const family = `tmuxde-preview-${id.replace(/[^a-zA-Z0-9]/g, "")}`;
  // The URL the loaded or failed face belongs to. A new URL starts over.
  const [face, setFace] = useState<{ url: string; status: "loaded" | "failed" } | null>(null);

  useEffect(() => {
    if (!url) return;
    const fontFace = new FontFace(family, `url("${url}")`);
    document.fonts.add(fontFace);
    let active = true;
    fontFace.load().then(
      () => {
        if (active) setFace({ url, status: "loaded" });
      },
      () => {
        if (active) setFace({ url, status: "failed" });
      },
    );
    return () => {
      active = false;
      document.fonts.delete(fontFace);
    };
  }, [url, family]);

  if (error || (face?.url === url && face.status === "failed"))
    return (
      <PreviewFailure path={path} target={target}>
        Unable to load this font. The file may be damaged, or in a format this browser does not
        read.
      </PreviewFailure>
    );
  if (loading || !url || face?.url !== url) return <Notice>Loading font...</Notice>;
  return (
    <div className="min-h-0 flex-1 overflow-auto px-6 py-6" style={{ fontFamily: `"${family}"` }}>
      <p className="text-4xl leading-tight">{FONT_SAMPLE}</p>
      <p className="mt-4 text-2xl leading-snug">{FONT_SAMPLE}</p>
      <p className="mt-3 text-base">{FONT_SAMPLE}</p>
      <p className="mt-6 break-all text-lg leading-relaxed">{FONT_GLYPHS}</p>
    </div>
  );
}

/** A file with no preview: name, kind, size and the download. */
export function BinaryPreview({
  path,
  size,
  target,
  note = "No preview for this file type.",
}: {
  path: string;
  size?: number;
  target?: string;
  note?: string;
}) {
  const category = getFileCategory(path) ?? "binary";
  const Icon = CATEGORY_ICONS[category] ?? FileQuestion;
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
      <Icon aria-hidden className="h-12 w-12 text-muted-foreground opacity-40" strokeWidth={1.5} />
      <p className="max-w-full break-all text-sm font-medium">{baseName(path)}</p>
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Badge variant="secondary" className="capitalize">
          {category}
        </Badge>
        {size !== undefined && <span>{formatFileSize(size)}</span>}
      </div>
      <p className="text-sm text-muted-foreground">{note}</p>
      <Button onClick={() => startDownload(path, target)}>
        <Download className="me-2 h-4 w-4" aria-hidden />
        Download
      </Button>
    </div>
  );
}
