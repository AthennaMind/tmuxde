import { Pin, PinOff } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import {
  GROUP_LABELS,
  useSettingsStore,
  type ToolbarKey,
  type ToolbarKeyGroup,
} from "@/stores/settings-store";
import { useConnectionStore } from "@/stores/connection-store";
import { sendKeySequence } from "@/lib/send-key";

/**
 * Every key, one tap from the terminal.
 *
 * The toolbar can hold about eight keys before it stops being scannable on a
 * phone, and an agent CLI needs closer to thirty. The old answer was a settings
 * screen: leave the terminal, find the chip, come back, use it once. So the
 * long tail lives here instead — tap to send it now, pin it if it turns out you
 * want it every day.
 *
 * The sticky Ctrl/Alt modifiers deliberately do not apply in here. They are a
 * toolbar affordance for composing arbitrary combinations, and every sequence
 * in this sheet is already complete — routing `^A` through the sticky-Ctrl
 * transform would produce something nobody asked for.
 */
const GROUP_ORDER: ToolbarKeyGroup[] = [
  "agent",
  "core",
  "edit",
  "nav",
  "symbol",
];

export function KeySheet({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const toolbarKeys = useSettingsStore((s) => s.toolbarKeys);
  const toggleToolbarKey = useSettingsStore((s) => s.toggleToolbarKey);
  const connected = useConnectionStore((s) => s.status === "connected");

  const groups = GROUP_ORDER.map((group) => ({
    group,
    keys: toolbarKeys.filter((k) => k.group === group && k.key !== ""),
  })).filter((g) => g.keys.length > 0);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="flex h-[70vh] flex-col px-4 pt-4">
        <SheetHeader className="pb-2 text-left">
          <SheetTitle className="text-sm">Keys</SheetTitle>
          <SheetDescription className="text-xs">
            Tap to send it now. Pin the ones you want in the toolbar.
          </SheetDescription>
        </SheetHeader>

        <ScrollArea className="-mx-4 h-0 flex-1 px-4">
          <div className="space-y-5 pb-6">
            {groups.map(({ group, keys }) => (
              <section key={group}>
                <h3 className="mb-2 text-xs font-semibold text-muted-foreground">
                  {GROUP_LABELS[group]}
                </h3>
                <ul className="space-y-1.5">
                  {keys.map((key) => (
                    <KeyRow
                      key={key.id}
                      entry={key}
                      connected={connected}
                      onSend={() => sendKeySequence(key.key)}
                      onTogglePin={() => toggleToolbarKey(key.id)}
                    />
                  ))}
                </ul>
              </section>
            ))}
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}

function KeyRow({
  entry,
  connected,
  onSend,
  onTogglePin,
}: {
  entry: ToolbarKey;
  connected: boolean;
  onSend: () => void;
  onTogglePin: () => void;
}) {
  return (
    <li className="flex items-center gap-2">
      {/* The whole row sends, so a key is one tap rather than a hunt for a
          target the width of its label. */}
      <button
        type="button"
        onClick={onSend}
        disabled={!connected}
        className={cn(
          "flex min-h-11 flex-1 items-center gap-3 rounded-md border border-border px-3 py-2 text-left transition-colors",
          "active:bg-accent/80 disabled:opacity-40",
          "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        )}
      >
        <span className="min-w-14 shrink-0 rounded bg-muted px-2 py-1 text-center font-mono text-xs">
          {entry.label}
        </span>
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          {entry.hint ?? sequenceHint(entry.key)}
        </span>
      </button>
      <button
        type="button"
        onClick={onTogglePin}
        aria-pressed={entry.visible}
        aria-label={
          entry.visible
            ? `Remove ${entry.label} from the toolbar`
            : `Pin ${entry.label} to the toolbar`
        }
        className={cn(
          "flex h-11 w-11 shrink-0 items-center justify-center rounded-md border border-border transition-colors",
          "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
          entry.visible
            ? "border-primary bg-primary/10 text-primary"
            : "text-muted-foreground",
        )}
      >
        {entry.visible ? (
          <Pin className="h-4 w-4" aria-hidden />
        ) : (
          <PinOff className="h-4 w-4" aria-hidden />
        )}
      </button>
    </li>
  );
}

/**
 * A readable form of the bytes, for keys with nothing better to say.
 *
 * Shown because "^W" is a guess and `\x17` is not — someone deciding whether to
 * pin a key deserves to know what it actually sends.
 */
export function sequenceHint(sequence: string): string {
  return sequence
    .split("")
    .map((ch) => {
      const code = ch.charCodeAt(0);
      if (ch === "\x1b") return "ESC";
      if (ch === "\t") return "TAB";
      if (ch === "\r") return "CR";
      if (code < 32) return `^${String.fromCharCode(code + 64)}`;
      return ch;
    })
    .join(" ");
}
