import { useEffect } from "react";
import { X, Download, FileText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useFileStore } from "./file-store";
import { startDownload } from "./transfer-store";
import { formatFileSize, getFileViewMode, type FileViewMode } from "./file-utils";
import { MediaPreview } from "./media-preview";
import { getRelayClient } from "@/features/connection/use-websocket";

const VIEW_MODE_LABELS: Record<FileViewMode, string> = {
  text: "text",
  image: "image",
  video: "video",
  audio: "audio",
  pdf: "PDF",
  font: "font",
  binary: "binary",
};

/**
 * The full screen view of a file that is not text, opened with "Open in
 * editor". Text goes to the Monaco editor instead.
 */
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
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{fileName}</span>
        <Badge variant="secondary" className="text-[10px]">
          {VIEW_MODE_LABELS[viewMode]}
        </Badge>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          title="Download"
          aria-label="Download"
          onClick={() => startDownload(editorFile)}
        >
          <Download className="h-4 w-4" aria-hidden />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          title="Open as text"
          aria-label="Open as text"
          onClick={() => openEditorAsText(editorFile)}
        >
          <FileText className="h-4 w-4" aria-hidden />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          title="Close"
          aria-label="Close"
          onClick={closeEditor}
        >
          <X className="h-4 w-4" aria-hidden />
        </Button>
      </div>

      {/* Content */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {viewMode !== "text" && (
          <MediaPreview path={editorFile} mode={viewMode} size={fileStat?.size} />
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
