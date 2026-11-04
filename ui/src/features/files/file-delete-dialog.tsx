import { useEffect, useRef, useState } from "react";
import type { FileEntry } from "@/protocol";
import type { RepositoryClient } from "@/features/repository/repository-request";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogFooter,
  AlertDialogCancel,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { deleteFileEntry } from "./file-delete";

export interface DeleteTarget {
  entry: FileEntry;
  client: RepositoryClient;
  machine: string;
}

export function FileDeleteDialog({
  target,
  onClose,
  onDeleted,
  onReturnFocus,
}: {
  target: DeleteTarget;
  onClose: () => void;
  onDeleted: () => void;
  onReturnFocus: () => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  const remove = async () => {
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setPending(true);
    setError(null);
    try {
      await deleteFileEntry(target.client, target.machine, target.entry.path, controller.signal);
      if (!controller.signal.aborted) onDeleted();
    } catch (cause) {
      if (!controller.signal.aborted) setError((cause as Error).message);
    } finally {
      request.current = null;
      if (!controller.signal.aborted) setPending(false);
    }
  };
  return (
    <AlertDialog open onOpenChange={(open) => !open && !pending && onClose()}>
      <AlertDialogContent
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          onReturnFocus();
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {target.entry.name}?</AlertDialogTitle>
          <AlertDialogDescription className="break-all">
            {target.entry.path}
            <br />
            {target.entry.type === "directory"
              ? "Folder and all its contents will be permanently deleted."
              : "This item will be permanently deleted."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <Button variant="destructive" disabled={pending} onClick={() => void remove()}>
            {pending ? "Deleting…" : "Delete"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
