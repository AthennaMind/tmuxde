import { Search } from "lucide-react";
import { Kbd } from "@/features/palette/palette-primitives";
import { openPalette } from "@/features/palette/palette-store";
import { useKeybindingsStore } from "@/features/keybindings/keybindings-store";
import { shortcutLabel } from "@/features/keybindings/shortcut-label";

export function QuickOpenTrigger() {
  const keymap = useKeybindingsStore((s) => s.keymap);
  const hint = shortcutLabel("palette.files", keymap);
  return (
    <div className="shrink-0 px-3 py-2">
      <button
        type="button"
        onClick={() => openPalette("files")}
        className="flex min-h-12 w-full items-center gap-2.5 rounded-2xl border border-line-subtle bg-surface-panel px-3 text-sm text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Search className="size-4 shrink-0" aria-hidden />
        <span className="flex-1 text-left">Find a file…</span>
        {hint && <Kbd className="hidden sm:inline-flex">{hint}</Kbd>}
      </button>
    </div>
  );
}
