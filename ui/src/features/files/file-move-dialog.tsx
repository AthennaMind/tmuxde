import { useId, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { useFileMoves } from "./use-file-moves";

export function FileMoveDialog({ moves }: { moves: ReturnType<typeof useFileMoves> }) {
  const id = useId();
  const [directory, setDirectory] = useState("");
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog open onOpenChange={(open) => !open && !moves.moving && moves.setSelection(null)}>
      <DialogContent>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (!moves.selection) return;
            setError(null);
            void moves
              .move(moves.selection.path, directory)
              .catch((cause: Error) => setError(cause.message));
          }}
        >
          <DialogHeader>
            <DialogTitle>Move to folder</DialogTitle>
            <DialogDescription className="break-all">{moves.selection?.path}</DialogDescription>
          </DialogHeader>
          <Label htmlFor={id}>Destination folder</Label>
          <Input
            id={id}
            value={directory}
            onChange={(event) => setDirectory(event.target.value)}
            placeholder="/path/to/folder"
            disabled={moves.moving}
            aria-invalid={!!error}
            aria-describedby={error ? `${id}-error` : undefined}
          />
          {error && (
            <p id={`${id}-error`} role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={moves.moving}
              onClick={() => moves.setSelection(null)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={!directory || moves.moving || !moves.allowed}>
              {moves.moving ? "Moving…" : "Move"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
