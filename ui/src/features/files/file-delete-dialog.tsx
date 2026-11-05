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
import { deleteFileEntries } from "./file-delete";

export interface DeleteTarget {
  entries: FileEntry[];
  client: RepositoryClient;
  machine: string;
  paneId: string;
  root: string | null;
}

export function FileDeleteDialog({
  target,
  onClose,
  onDeleted,
  onEntryDeleted,
  onReturnFocus,
}: {
  target: DeleteTarget;
  onClose: () => void;
  onDeleted: () => void;
  onEntryDeleted: (entry: FileEntry) => void;
  onReturnFocus: () => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleted, setDeleted] = useState(0);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  const remove = async () => {
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setPending(true);
    setError(null);
    try {
      await deleteFileEntries(
        target.client,
        target.machine,
        target.entries,
        controller.signal,
        (entry) => {
          setDeleted((count) => count + 1);
          onEntryDeleted(entry);
        },
      );
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
          <AlertDialogTitle>
            Delete{" "}
            {target.entries.length === 1
              ? target.entries[0]!.name
              : `${target.entries.length} items`}
            ?
          </AlertDialogTitle>
          <AlertDialogDescription className="break-all">
            {target.entries.length === 1
              ? target.entries[0]!.type === "directory"
                ? "Folder and all its contents will be permanently deleted."
                : "This item will be permanently deleted."
              : "Selected items and folder contents will be permanently deleted."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <ul className="max-h-48 overflow-auto text-sm">
          {target.entries.map((entry) => (
            <li key={entry.path} className="break-all">
              {entry.path}
            </li>
          ))}
        </ul>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {deleted > 0 ? `${deleted} of ${target.entries.length} items deleted. ` : ""}
            {error} Refresh folder before trying again.
          </p>
        )}
        <p role="status" className="sr-only">
          {pending ? `${deleted} of ${target.entries.length} items deleted` : ""}
        </p>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>{error ? "Close" : "Cancel"}</AlertDialogCancel>
          {!error && (
            <Button variant="destructive" disabled={pending} onClick={() => void remove()}>
              {pending ? "Deleting…" : "Delete"}
            </Button>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
