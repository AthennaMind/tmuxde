"use client";

import { Circle, Trash2 } from "lucide-react";
import Link from "next/link";
import { useEffect } from "react";

import { Button } from "@repo/ui/components/ui/button";

import { getRelayClient, useRelayClient } from "@/hooks/use-websocket";
import { formatTimecode } from "@/lib/player-clock";
import {
  isRecordingsScope,
  supportsRecording,
  useConnectionStore,
} from "@/stores/connection-store";
import { useRecordingStore } from "@/stores/recording-store";

/**
 * The recordings this connection may see.
 *
 * The list is server-filtered — a recordings-scoped share is sent exactly the
 * ones it was granted — so there is nothing to filter here. What this does have
 * to get right is the empty state, which means three different things: no
 * recordings yet, a relay too old to have any, and a share whose recording was
 * revoked. Only the first is worth a call to action.
 */
export function RecordingList() {
  const client = useRelayClient();
  const features = useConnectionStore((s) => s.features);
  const capabilities = useConnectionStore((s) => s.capabilities);
  const recordings = useRecordingStore((s) => s.recordings);
  const loading = useRecordingStore((s) => s.loading);
  const canRecord = supportsRecording(features);
  const sharedOnly = isRecordingsScope(capabilities);

  useEffect(() => {
    if (!client || !canRecord) return;
    useRecordingStore.getState().setLoading(true);
    client.send({ type: "recording:list" });
  }, [client, canRecord]);

  if (!canRecord) {
    return (
      <Empty
        title="This machine cannot record"
        body="Its mtmux is older than recording. Update it with `npm i -g mtmux`."
      />
    );
  }

  if (loading && recordings.length === 0) {
    return <Empty title="Loading recordings…" body="" />;
  }

  if (recordings.length === 0) {
    return sharedOnly ? (
      <Empty
        title="Nothing here"
        body="This share no longer points at a recording. Whoever sent it may have revoked it or deleted the file."
      />
    ) : (
      <Empty
        title="No recordings yet"
        body="Run `mtmux record <session>` on the machine to capture one."
      />
    );
  }

  return (
    <div className="mx-auto w-full max-w-3xl p-4">
      <h1 className="mb-4 text-lg font-semibold">Recordings</h1>
      <ul className="flex flex-col gap-2">
        {[...recordings].reverse().map((recording) => {
          const live = recording.endedAt === null;
          const seconds =
            ((recording.endedAt ?? Date.now()) - recording.startedAt) / 1000;
          return (
            <li
              key={recording.id}
              className="flex items-center gap-3 rounded-lg border border-border bg-card p-3"
            >
              <div className="min-w-0 flex-1">
                <Link
                  href={`/r/${recording.id}`}
                  className="block truncate font-medium hover:underline"
                >
                  {recording.title}
                </Link>
                <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                  {live ? (
                    <span className="inline-flex items-center gap-1 text-destructive">
                      <Circle
                        aria-hidden="true"
                        className="size-2 fill-current"
                      />
                      recording
                    </span>
                  ) : null}
                  <span className="font-mono">{formatTimecode(seconds)}</span>
                  <span className="font-mono">
                    {recording.cols}×{recording.rows}
                  </span>
                  {recording.target.kind === "pane" ? (
                    <span className="font-mono">
                      pane {recording.target.paneId}
                    </span>
                  ) : null}
                  {recording.truncated ? (
                    <span className="text-warning">cut off</span>
                  ) : null}
                </p>
              </div>

              {sharedOnly ? null : (
                <Button
                  size="icon"
                  variant="ghost"
                  // `size-11`, not the default icon size: this is the only
                  // control on the row and a thumb has to hit it. 44px is the
                  // tap target floor, and the default was 36.
                  className="size-11 shrink-0"
                  aria-label={`Delete recording ${recording.title}`}
                  onClick={() =>
                    getRelayClient()?.send({
                      type: "recording:delete",
                      id: recording.id,
                    })
                  }
                >
                  <Trash2 className="size-4" />
                </Button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function Empty({ title, body }: { title: string; body: string }) {
  return (
    <div className="mx-auto flex w-full max-w-md flex-col items-center gap-2 p-10 text-center">
      <p className="font-medium">{title}</p>
      {body ? <p className="text-sm text-muted-foreground">{body}</p> : null}
    </div>
  );
}
