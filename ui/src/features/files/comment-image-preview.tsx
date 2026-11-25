import { useEffect, useRef } from "react";
import { cn } from "@/shared/utils";

export function CommentImagePreview({ file, className }: { file: File; className?: string }) {
  const ref = useRef<HTMLImageElement>(null);
  useEffect(() => {
    const src = URL.createObjectURL(file);
    if (ref.current) ref.current.src = src;
    return () => URL.revokeObjectURL(src);
  }, [file]);
  return (
    <img ref={ref} alt="Attached screenshot" className={cn("rounded object-cover", className)} />
  );
}
