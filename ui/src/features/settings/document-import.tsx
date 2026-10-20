import { useRef, useState } from "react";
import { CircleAlert, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import type { UserDocumentName } from "@/protocol";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { importMessage, readImportFile, type ImportCandidate } from "./settings-import";
import type { DocumentIssue } from "./settings-schema";
import { useUserDocumentsStore } from "./user-documents-store";

const DOCUMENT_TITLES: Record<UserDocumentName, string> = {
  settings: "Settings",
  keybindings: "Keybindings",
};

function IssueList({ issues }: { issues: readonly DocumentIssue[] }) {
  if (issues.length === 0) return null;
  return (
    <ul className="max-h-48 space-y-1 overflow-y-auto overscroll-contain rounded-md border bg-surface-sunken p-3">
      {issues.map((issue, index) => (
        <li
          key={`${index}:${issue.path ?? ""}:${issue.message}`}
          className="flex items-start gap-2 text-[13px] leading-5"
        >
          {issue.severity === "error" ? (
            <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-destructive" aria-hidden />
          ) : (
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-warning" aria-hidden />
          )}
          <span className="sr-only">{issue.severity === "error" ? "Error" : "Warning"}:</span>
          <span className="min-w-0 break-words">
            {issue.path && <code className="me-1.5 font-mono text-foreground">{issue.path}</code>}
            <span className="text-muted-foreground">{issue.message}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Import button with its file picker and confirm dialog.
 *
 * The file's shape says which document it is: an object is settings, an
 * array keybindings. `only` limits the import to one of them and names the
 * other file when it is picked. The dialog shows the count and the issues
 * before anything is saved. Keyboard shortcuts and Settings files each
 * render one, so both share this flow.
 */
export function DocumentImport({
  only,
  "aria-label": ariaLabel,
}: {
  only?: UserDocumentName;
  "aria-label"?: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const importRef = useRef<HTMLButtonElement>(null);
  const [candidate, setCandidate] = useState<ImportCandidate | null>(null);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);

  const canImport = !!candidate?.name && candidate.check.valid;
  const message = candidate ? importMessage(candidate, only) : null;

  async function pick(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    // Cleared, so picking the same file again fires change again.
    event.target.value = "";
    if (!file) return;
    setImportError(null);
    setCandidate(await readImportFile(file, only));
  }

  async function confirmImport() {
    if (!candidate?.name || !candidate.check.valid) return;
    const { name, text } = candidate;
    setImporting(true);
    setImportError(null);
    const outcome = await useUserDocumentsStore.getState().save(name, text);
    setImporting(false);
    if (outcome === "saved" || outcome === "unchanged") {
      setCandidate(null);
      toast.success(`${DOCUMENT_TITLES[name]} imported`);
      return;
    }
    if (outcome === "conflict") {
      // The server copy is newer. Import again on top of it.
      useUserDocumentsStore.getState().dismissConflict(name);
      setImportError(
        `${DOCUMENT_TITLES[name]} changed in another browser just now. Import again to replace them.`,
      );
      return;
    }
    const reason = useUserDocumentsStore.getState().documents[name].lastError;
    setImportError(
      reason
        ? `Unable to import. ${reason}`
        : "Unable to import. Check your connection and try again.",
    );
  }

  return (
    <>
      <Button
        ref={importRef}
        size="sm"
        variant="outline"
        className="pointer-coarse:h-11"
        aria-label={ariaLabel}
        onClick={() => inputRef.current?.click()}
      >
        Import
      </Button>
      <input
        ref={inputRef}
        type="file"
        accept="application/json,.json"
        className="hidden"
        onChange={(event) => void pick(event)}
      />

      <AlertDialog
        open={candidate !== null}
        onOpenChange={(open) => {
          if (!open && !importing) setCandidate(null);
        }}
      >
        {candidate && message && (
          <AlertDialogContent
            onCloseAutoFocus={(event) => {
              // Opened from the file picker, not a trigger, so Radix would
              // leave focus on the body. Back to Import instead.
              event.preventDefault();
              importRef.current?.focus();
            }}
          >
            <AlertDialogHeader>
              <AlertDialogTitle className="break-words">{message.title}</AlertDialogTitle>
              <AlertDialogDescription className="text-pretty">
                {message.description}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <IssueList issues={candidate.check.issues} />
            {importError && (
              <p role="alert" className="text-[13px] leading-5 text-destructive text-pretty">
                {importError}
              </p>
            )}
            <AlertDialogFooter>
              {canImport ? (
                <>
                  <AlertDialogCancel disabled={importing} className="pointer-coarse:h-11">
                    Cancel
                  </AlertDialogCancel>
                  <AlertDialogAction
                    disabled={importing}
                    className="pointer-coarse:h-11"
                    onClick={(event) => {
                      // Stay open while it saves, and on a failure.
                      event.preventDefault();
                      void confirmImport();
                    }}
                  >
                    {importing
                      ? "Importing…"
                      : candidate.name === "settings"
                        ? "Import settings"
                        : "Import keybindings"}
                  </AlertDialogAction>
                </>
              ) : (
                <AlertDialogCancel className="pointer-coarse:h-11">Close</AlertDialogCancel>
              )}
            </AlertDialogFooter>
          </AlertDialogContent>
        )}
      </AlertDialog>
    </>
  );
}
