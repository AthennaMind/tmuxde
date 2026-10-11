"use client";

import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { cn } from "@repo/ui/lib/utils";
import { useDictationStore } from "@/stores/dictation-store";
import { cancelDictation, stopDictation } from "@/lib/dictation";

const BARS = [0.15, 0.35, 0.6, 0.85];

/** Four bars. Speech RMS sits around 0.02 to 0.2, so the scale is a root. */
function LevelMeter({ level }: { level: number }) {
  const loudness = Math.min(1, Math.sqrt(level) * 2.5);
  return (
    <span aria-hidden className="flex h-4 items-end gap-0.5">
      {BARS.map((threshold, i) => (
        <span
          key={threshold}
          className={cn(
            "w-1 rounded-full transition-colors",
            loudness >= threshold ? "bg-destructive" : "bg-muted-foreground/30",
          )}
          style={{ height: `${40 + i * 20}%` }}
        />
      ))}
    </span>
  );
}

function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/**
 * Shows that the microphone is live, and how to end it.
 *
 * A live microphone has to be impossible to miss. Stop keeps what was said;
 * the cross throws it away.
 */
export function DictationIndicator() {
  const status = useDictationStore((s) => s.status);
  const level = useDictationStore((s) => s.level);
  const startedAt = useDictationStore((s) => s.startedAt);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (status !== "listening") return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [status]);

  if (status === "idle") return null;

  const label =
    status === "starting"
      ? "Starting microphone…"
      : status === "listening"
        ? "Listening"
        : "Transcribing…";

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-3 z-[var(--z-banner)] flex justify-center px-4">
      <div className="pointer-events-auto flex items-center gap-2 rounded-full border border-border bg-background py-1 pe-1 ps-3 font-chrome shadow-md">
        {status === "listening" && <LevelMeter level={level} />}
        <span role="status" className="text-xs font-medium text-foreground">
          {label}
        </span>
        {status === "listening" && startedAt && (
          <span aria-hidden className="text-xs tabular-nums text-muted-foreground">
            {formatElapsed(now - startedAt)}
          </span>
        )}
        {status !== "stopping" && (
          <button
            type="button"
            onPointerDown={(event) => event.preventDefault()}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => void stopDictation()}
            className="h-8 rounded-full bg-destructive px-3 text-xs font-medium text-destructive-foreground hover:bg-destructive/90 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            Stop
          </button>
        )}
        <button
          type="button"
          aria-label="Cancel dictation and discard"
          title="Cancel and discard"
          onPointerDown={(event) => event.preventDefault()}
          onMouseDown={(event) => event.preventDefault()}
          onClick={cancelDictation}
          className="flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <X aria-hidden className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
