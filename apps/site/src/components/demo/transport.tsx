"use client";

import { Pause, Play, RotateCcw } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * Play/pause, restart and a scrubber.
 *
 * All three are `disabled` under reduced motion — there is no timeline to
 * scrub when nothing is animating — and an `aria-describedby` note says why,
 * because a control that is disabled for an unexplained reason reads as
 * broken.
 */
export function Transport({
  playing,
  ended,
  progress,
  reduced,
  labels,
  onToggle,
  onRestart,
  onSeek,
  className,
}: {
  playing: boolean;
  ended: boolean;
  /** 0..1 */
  progress: number;
  reduced: boolean;
  labels: {
    play: string;
    pause: string;
    restart: string;
    progress: string;
    reducedNote: string;
  };
  onToggle: () => void;
  onRestart: () => void;
  onSeek: (fraction: number) => void;
  className?: string;
}) {
  const noteId = "demo-reduced-motion-note";

  return (
    <div className={cn("flex items-center gap-3", className)}>
      <button
        type="button"
        onClick={ended ? onRestart : onToggle}
        disabled={reduced}
        aria-label={ended ? labels.restart : playing ? labels.pause : labels.play}
        aria-describedby={reduced ? noteId : undefined}
        className={cn(
          "grid size-9 shrink-0 place-items-center rounded-full border border-line bg-surface-panel text-text-muted transition-colors",
          "hover:border-line-strong hover:text-text-strong",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand",
          "disabled:cursor-not-allowed disabled:opacity-40",
          // The pulse ring only appears once there is a reason to press it.
          ended && !reduced && "animate-pulse-ring border-brand text-brand",
        )}
      >
        {ended ? (
          <RotateCcw className="size-4" />
        ) : playing ? (
          <Pause className="size-4" />
        ) : (
          <Play className="size-4" />
        )}
      </button>

      <input
        type="range"
        min={0}
        max={1000}
        value={Math.round(progress * 1000)}
        disabled={reduced}
        aria-label={labels.progress}
        aria-describedby={reduced ? noteId : undefined}
        onChange={(e) => onSeek(Number(e.target.value) / 1000)}
        className={cn(
          "h-1 w-full cursor-pointer appearance-none rounded-full bg-line",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-surface-base",
          "disabled:cursor-not-allowed disabled:opacity-40",
          "[&::-webkit-slider-thumb]:size-3 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-brand",
          "[&::-moz-range-thumb]:size-3 [&::-moz-range-thumb]:appearance-none [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-brand",
        )}
        style={{
          background: `linear-gradient(to right, var(--color-brand) ${progress * 100}%, var(--color-line) ${progress * 100}%)`,
        }}
      />

      {reduced && (
        <p id={noteId} className="sr-only">
          {labels.reducedNote}
        </p>
      )}
    </div>
  );
}
