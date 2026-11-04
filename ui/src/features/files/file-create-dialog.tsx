import { useEffect, useId, useRef, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { RepositoryClient } from "@/features/repository/repository-request";
import { createFileEntry, newEntryPath, type CreateKind } from "./file-create-request";

export interface CreateTarget {
  directory: string;
  machine: string;
  paneId: string;
  client: RepositoryClient;
  kind: CreateKind;
}

export function FileCreateDialog({
  target,
  onClose,
  onCreated,
  onReturnFocus,
}: {
  target: CreateTarget;
  onClose: () => void;
  onCreated: (path: string) => void;
  onReturnFocus?: () => void;
}) {
  const id = useId();
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const request = useRef<AbortController | null>(null);
  const created = useRef(false);
  const returnFocus = useRef(document.activeElement);
  useEffect(() => () => request.current?.abort(), []);

  const create = async () => {
    if (request.current) return;
    setError(null);
    let path: string;
    try {
      path = newEntryPath(target.directory, name);
    } catch (cause) {
      setError((cause as Error).message);
      return;
    }
    const controller = new AbortController();
    request.current = controller;
    setPending(true);
    try {
      await createFileEntry(target.client, path, target.kind, controller.signal);
      if (!controller.signal.aborted) {
        created.current = true;
        onCreated(path);
      }
    } catch (cause) {
      if (!controller.signal.aborted) setError((cause as Error).message);
    } finally {
      request.current = null;
      if (!controller.signal.aborted) setPending(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && !pending && onClose()}>
      <DialogContent
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (created.current) return;
          if (onReturnFocus) onReturnFocus();
          else if (returnFocus.current instanceof HTMLElement) returnFocus.current.focus();
        }}
      >
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            void create();
          }}
        >
          <DialogHeader>
            <DialogTitle>New {target.kind}</DialogTitle>
            <DialogDescription className="break-all">
              Create in {target.directory}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor={id}>{target.kind === "file" ? "File name" : "Folder name"}</Label>
            <Input
              id={id}
              value={name}
              onChange={(event) => setName(event.target.value)}
              disabled={pending}
              autoComplete="off"
              aria-invalid={!!error}
              aria-describedby={error ? `${id}-error` : undefined}
            />
            {error && (
              <p id={`${id}-error`} role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={pending} onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending || !name.trim()}>
              {pending ? "Creating…" : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
