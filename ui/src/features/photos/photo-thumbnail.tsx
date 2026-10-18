import { ImageOff } from "lucide-react";
import { cn } from "@/shared/utils";
import { useFileObjectUrl } from "@/features/files/use-file-object-url";

export function PhotoThumbnail({ path, className }: { path: string; className?: string }) {
  const { url, loading } = useFileObjectUrl(path);
  return (
    <span
      className={cn(
        "flex shrink-0 items-center justify-center overflow-hidden rounded bg-muted",
        className,
      )}
      title={loading ? "Loading photo" : url ? "Uploaded photo" : "Preview unavailable"}
    >
      {url ? (
        // Blob URLs come from authenticated requests and expire on unmount.
        <img src={url} alt="Uploaded photo" className="h-full w-full object-cover" />
      ) : (
        <ImageOff className="h-4 w-4 text-muted-foreground" aria-hidden />
      )}
    </span>
  );
}
