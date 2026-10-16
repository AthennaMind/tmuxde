import { useEffect, useId } from "react";
import { configurePreviews } from "@/stores/terminal-preview-store";

export function PreviewControls({ size, setSize }: { size: string; setSize: (size: string) => void }) {
  const sizeId = useId();
  useEffect(() => {
    configurePreviews({ open: true, hidden: document.hidden });
    return () => configurePreviews({ open: false, hidden: document.hidden });
  }, []);
  return <div className="flex flex-wrap items-center gap-3">
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      <label htmlFor={sizeId}>Preview size</label>
      <select id={sizeId} value={size} onChange={(event) => setSize(event.target.value)}
        className="min-h-9 rounded-md border bg-background px-2 text-xs text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring pointer-coarse:min-h-11">
        <option value="16rem">Small</option>
        <option value="20rem">Medium</option>
        <option value="32rem">Large</option>
      </select>
    </div>
  </div>;
}
