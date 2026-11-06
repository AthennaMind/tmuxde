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
import type { ChangeTarget } from "./change-actions";

export function ChangeDiscardDialog({
  target,
  pending,
  completed,
  error,
  onConfirm,
  onClose,
}: {
  target: ChangeTarget;
  pending: boolean;
  completed: number;
  error: string | null;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const deleting = target.scope === "untracked";
  const label =
    target.entries.length === 1 ? target.entries[0]!.path : `${target.entries.length} files`;
  return (
    <AlertDialog open onOpenChange={(open) => !open && !pending && onClose()}>
      <AlertDialogContent
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          requestAnimationFrame(() =>
            document
              .querySelector<HTMLElement>("[data-change-menu-origin], [data-changes-list]")
              ?.focus({ preventScroll: true }),
          );
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle className="break-words">
            {deleting ? `Delete ${label}?` : `Discard changes to ${label}?`}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {deleting
              ? "Selected untracked files will be permanently deleted. Git cannot recover them."
              : "Unstaged changes will be lost. Files will return to their staged versions. Staged changes will be kept."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <ul className="max-h-48 overflow-auto text-sm">
          {target.entries.map((entry) => (
            <li key={entry.path} className="break-all">
              {entry.path}
            </li>
          ))}
        </ul>
        {pending && (
          <p role="status" className="text-sm text-muted-foreground">
            {completed} of {target.entries.length} files changed
          </p>
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {completed > 0 && `${completed} of ${target.entries.length} files changed. `}
            {error} Refresh Changes before trying again.
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel className="pointer-coarse:min-h-11" disabled={pending}>
            {error ? "Close" : "Cancel"}
          </AlertDialogCancel>
          {!error && (
            <Button
              className="pointer-coarse:min-h-11"
              variant="destructive"
              disabled={pending}
              onClick={onConfirm}
            >
              {pending ? "Working…" : deleting ? "Delete" : "Discard changes"}
            </Button>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
