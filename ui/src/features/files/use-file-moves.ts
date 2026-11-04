import { useEffect, useRef, useState, type DragEvent } from "react";
import type { FileEntry } from "@/protocol";
import type { RepositoryClient } from "@/features/repository/repository-request";
import { machineId } from "@/features/connection/machine-context";
import { useConnectionStore } from "@/features/connection/connection-store";
import { useAlertStore } from "@/shared/alert-store";
import { moveDestination, moveFileEntry } from "./file-move";

const MIME = "application/x-tmuxde-file";

export function useFileMoves(
  client: RepositoryClient | null,
  onMoved: (from: string, to: string) => void,
) {
  const allowed = useConnectionStore(
    (state) =>
      state.status === "connected" &&
      state.features.has("file:rename:no-replace") &&
      !state.capabilities?.readOnly &&
      (!state.capabilities || state.capabilities.files === "write"),
  );
  const source = useRef<{ machine: string; path: string } | null>(null);
  const pending = useRef<AbortController | null>(null);
  const [moving, setMoving] = useState(false);
  const [over, setOver] = useState<string | null>(null);
  const [selection, setSelection] = useState<FileEntry | null>(null);
  useEffect(
    () => () => {
      pending.current?.abort();
      source.current = null;
    },
    [client],
  );

  const move = async (from: string, directory: string) => {
    if (!client || !allowed || pending.current)
      throw new Error("Connect and wait for current move to finish.");
    const controller = new AbortController();
    pending.current = controller;
    setMoving(true);
    try {
      const to = await moveFileEntry(client, machineId(), from, directory, controller.signal);
      if (!controller.signal.aborted) {
        onMoved(from, to);
        setSelection(null);
      }
    } finally {
      if (pending.current === controller) {
        pending.current = null;
        setMoving(false);
      }
    }
  };

  const canDrop = (directory: string) => {
    if (!allowed || moving || !source.current || source.current.machine !== machineId())
      return false;
    try {
      moveDestination(source.current.path, directory);
      return true;
    } catch {
      return false;
    }
  };

  const dropProps = (directory: string | null) => ({
    "data-file-drop-target": directory ?? undefined,
    onDragOver: (event: DragEvent<HTMLElement>) => {
      if (!event.dataTransfer.types.includes(MIME)) return;
      event.stopPropagation();
      if (!directory || !canDrop(directory)) {
        event.dataTransfer.dropEffect = "none";
        return;
      }
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      setOver(directory);
    },
    onDragLeave: (event: DragEvent<HTMLElement>) => {
      if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
      setOver((current) => (current === directory ? null : current));
    },
    onDrop: (event: DragEvent<HTMLElement>) => {
      if (!event.dataTransfer.types.includes(MIME)) return;
      event.stopPropagation();
      event.preventDefault();
      setOver(null);
      if (!directory || !canDrop(directory)) return;
      const from = source.current!.path;
      source.current = null;
      void move(from, directory).catch((error: Error) => {
        if (error.name !== "AbortError") useAlertStore.getState().push("error", error.message);
      });
    },
  });

  const dragProps = (entry: FileEntry) => ({
    draggable: allowed && !moving,
    "data-file-drag-source": entry.path,
    onDragStart: (event: DragEvent<HTMLElement>) => {
      if (!allowed || moving) {
        event.preventDefault();
        return;
      }
      source.current = { machine: machineId(), path: entry.path };
      event.dataTransfer.setData(MIME, entry.path);
      event.dataTransfer.effectAllowed = "move";
    },
    onDragEnd: () => {
      source.current = null;
      setOver(null);
    },
  });

  return { allowed, moving, over, selection, setSelection, move, dragProps, dropProps };
}
