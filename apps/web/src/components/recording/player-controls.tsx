"use client";

import { Pause, Play, RotateCcw } from "lucide-react";
import type { Dispatch } from "react";

import { Button } from "@repo/ui/components/ui/button";

import {
  formatTimecode,
  nextSpeed,
  type PlayerAction,
  type PlayerState,
} from "@/lib/player-clock";

/**
 * Transport for the recording player.
 *
 * A `range` input for the scrubber rather than a custom track, because a range
 * input is already keyboard-operable, already announces its value, and already
 * has a thumb big enough for a finger. The one thing it needs help with is a
 * label, since "45" means nothing without a unit.
 */
export function PlayerControls({
  state,
  dispatch,
  title,
  truncated,
  totalBytes,
}: {
  state: PlayerState;
  dispatch: Dispatch<PlayerAction>;
  title?: string;
  truncated: boolean;
  totalBytes: number;
}) {
  const atEnd = state.t >= state.duration && state.duration > 0;

  return (
    <div className="flex flex-col gap-2">
      {/* A named group so the transport is addressable as a unit. Assistive
          tech would otherwise have to guess which "Play" on the page is this
          one. */}
      <div
        role="group"
        aria-label="Playback controls"
        className="flex items-center gap-3"
      >
        <Button
          size="icon"
          variant="secondary"
          className="size-11 shrink-0"
          onClick={() => dispatch({ type: "toggle" })}
          aria-label={
            state.playing
              ? "Pause"
              : atEnd
                ? "Play again from the start"
                : "Play"
          }
        >
          {state.playing ? (
            <Pause className="size-4" />
          ) : atEnd ? (
            <RotateCcw className="size-4" />
          ) : (
            <Play className="size-4" />
          )}
        </Button>

        <span className="font-mono text-xs tabular-nums text-muted-foreground">
          {formatTimecode(state.t)} / {formatTimecode(state.duration)}
        </span>

        <input
          type="range"
          min={0}
          max={Math.max(state.duration, 0.001)}
          step={0.05}
          value={state.t}
          onChange={(event) =>
            dispatch({ type: "seek", t: Number(event.target.value) })
          }
          aria-label="Seek within the recording"
          aria-valuetext={`${formatTimecode(state.t)} of ${formatTimecode(state.duration)}`}
          className="h-1.5 min-w-0 flex-1 cursor-pointer appearance-none rounded-full bg-muted accent-primary"
        />

        <Button
          size="sm"
          variant="ghost"
          onClick={() =>
            dispatch({ type: "speed", speed: nextSpeed(state.speed) })
          }
          aria-label={`Playback speed: ${state.speed}×. Tap to change.`}
          className="h-11 shrink-0 font-mono text-xs tabular-nums"
        >
          {state.speed}×
        </Button>
      </div>

      <p className="flex flex-wrap items-center gap-x-3 text-xs text-muted-foreground">
        {title ? <span className="truncate">{title}</span> : null}
        <span className="font-mono">{formatBytes(totalBytes)}</span>
        {truncated ? (
          // Said, not hidden. A recording that ends mid-thought with no
          // explanation reads as a bug in the player.
          <span className="text-warning">
            This recording was cut off before it was closed.
          </span>
        ) : null}
      </p>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
