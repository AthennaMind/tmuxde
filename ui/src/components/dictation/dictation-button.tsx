import { Loader2, Mic, Square } from "lucide-react";
import { cn } from "@/lib/utils";
import { triggerHaptic } from "@/components/haptic-button";
import { isReadOnly, useConnectionStore } from "@/stores/connection-store";
import { useDictationStore } from "@/stores/dictation-store";
import { useSettingsStore } from "@/stores/settings-store";
import { toggleDictation } from "@/lib/dictation";

/** Whether this connection is offered dictation at all. */
export function useDictationAvailable(): boolean {
  return useConnectionStore(
    (s) => s.features.has("dictation") && !isReadOnly(s.capabilities),
  );
}

/**
 * Start and stop dictation.
 *
 * Never takes focus. Where the words go is decided by what has focus when
 * dictation starts, so a tap on this button must leave the command bar or
 * terminal focused. On the phone it also keeps the keyboard up.
 */
export function DictationButton({
  variant,
  className,
}: {
  variant: "toolbar" | "rail";
  className?: string;
}) {
  const available = useDictationAvailable();
  const connected = useConnectionStore((s) => s.status === "connected");
  const status = useDictationStore((s) => s.status);
  const hapticEnabled = useSettingsStore((s) => s.hapticEnabled);
  if (!available) return null;

  const recording = status === "starting" || status === "listening";
  const label =
    status === "stopping"
      ? "Transcribing"
      : recording
        ? "Stop dictation"
        : "Start dictation";
  const Icon = status === "stopping" ? Loader2 : recording ? Square : Mic;

  return (
    <button
      type="button"
      // The keyboard toolbar keeps focus for buttons that carry this.
      data-terminal-key={variant === "toolbar" || undefined}
      aria-label={label}
      aria-pressed={recording}
      title={`${label} (Ctrl+Shift+Space)`}
      disabled={!connected || status === "stopping"}
      onPointerDown={(event) => event.preventDefault()}
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => {
        if (hapticEnabled && variant === "toolbar") triggerHaptic();
        toggleDictation();
      }}
      className={cn(
        "flex shrink-0 items-center justify-center rounded-md transition-colors disabled:opacity-40",
        // The rail takes the global 2px focus outline, like its neighbours.
        variant === "toolbar"
          ? "h-11 min-w-0 border border-border bg-background px-1 text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring active:bg-accent"
          : "h-9 w-9 text-muted-foreground hover:bg-accent/60 hover:text-foreground",
        recording && "border-destructive bg-destructive text-destructive-foreground hover:bg-destructive/90 hover:text-destructive-foreground active:bg-destructive/90",
        className,
      )}
    >
      <Icon
        aria-hidden
        className={cn(
          variant === "toolbar" ? "h-4 w-4" : "h-[18px] w-[18px]",
          recording && "fill-current",
          status === "stopping" && "animate-spin motion-reduce:animate-none",
        )}
      />
    </button>
  );
}
