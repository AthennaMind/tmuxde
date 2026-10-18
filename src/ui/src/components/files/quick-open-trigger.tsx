import { Search } from "lucide-react";
import { openPalette } from "@/stores/palette-store";

export function QuickOpenTrigger() {
  return (
    <div className="shrink-0 px-3 py-2">
      <button type="button" onClick={() => openPalette("files")}
        className="flex min-h-12 w-full items-center gap-2.5 rounded-2xl border border-line-subtle bg-surface-panel px-3 text-sm text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <Search className="size-4 shrink-0" aria-hidden />
        <span className="flex-1 text-left">Find a file…</span>
        <kbd className="hidden rounded-md bg-background px-1.5 py-1 font-mono text-[10px] sm:inline">Ctrl/Cmd P</kbd>
      </button>
    </div>
  );
}
