import { useImperativeHandle, useRef, useState, type Ref } from "react";
import { Download, Upload, X } from "lucide-react";
import { Button } from "@/components/ui/button";
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
import { machineId } from "@/lib/machine-context";
import { uploadLimit } from "@/lib/file-upload";
import { formatFileSize } from "@/lib/file-utils";
import { useConnectionStore } from "@/stores/connection-store";
import { useMachineStore } from "@/stores/machine-store";
import {
  cancelTransfer,
  clearFinishedTransfers,
  startDownload,
  startUploads,
  useTransferStore,
} from "@/stores/transfer-store";

export function DownloadButton({
  path,
  target = machineId(),
}: {
  path: string;
  target?: string;
}) {
  return (
    <Button
      variant="ghost"
      size="icon"
      className="h-11 w-11 shrink-0"
      aria-label={`Download ${path.split("/").pop()}`}
      title="Download"
      onClick={() => startDownload(path, target)}
    >
      <Download className="h-4 w-4" aria-hidden />
    </Button>
  );
}

export type UploadPicker = { choose: (directory?: string) => void };

/** Picker captures destination before browser focus leaves this page. */
export function UploadControl({
  directory,
  pickerRef,
}: {
  directory: string;
  pickerRef?: Ref<UploadPicker>;
}) {
  const input = useRef<HTMLInputElement>(null);
  const destination = useRef({ path: directory, machine: machineId(), name: "" });
  const [files, setFiles] = useState<File[]>([]);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const allowed = useConnectionStore((connection) =>
    connection.status === "connected" &&
    connection.features.has("file:upload:ack") &&
    !connection.capabilities?.readOnly &&
    (!connection.capabilities || connection.capabilities.files === "write"),
  );
  const open = (path = directory) => {
    if (!allowed) return;
    const target = machineId();
    const machine = useMachineStore.getState().machines.find((item) => item.id === target);
    destination.current = { path, machine: target, name: machine?.name ?? target };
    input.current?.click();
  };
  useImperativeHandle(pickerRef, () => ({ choose: open }));
  const limit = useConnectionStore((connection) => uploadLimit(connection.features));
  const limitLabel = limit === 10 * 1024 * 1024 ? "10 MiB" : "1 GiB";
  const oversized = files.some((file) => file.size > limit);

  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        className="h-11 w-11 shrink-0"
        aria-label="Upload files"
        title={`Upload to ${directory}`}
        disabled={!allowed}
        onClick={() => open()}
      >
        <Upload className="h-4 w-4" aria-hidden />
      </Button>
      <input
        ref={input}
        type="file"
        multiple
        className="hidden"
        aria-label="Choose files to upload"
        onChange={(event) => {
          const selected = Array.from(event.target.files ?? []);
          setFiles(selected);
          setConfirmOpen(selected.length > 0);
          event.target.value = "";
        }}
      />
      <AlertDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Upload {files.length} {files.length === 1 ? "file" : "files"}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Destination: {destination.current.name}<br />
              <span className="break-all font-mono">{destination.current.path}</span><br />
              Existing files with matching names will be replaced after upload
              completes. Limit: {limitLabel} per file.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <ul className="max-h-48 overflow-auto text-sm">
            {files.map((file, index) => (
              <li key={index} className="flex gap-2 py-1">
                <span className="min-w-0 flex-1 truncate">{file.name}</span>
                <span className="shrink-0 text-muted-foreground">{formatFileSize(file.size)}</span>
              </li>
            ))}
          </ul>
          {oversized && (
            <p role="alert" className="text-sm text-destructive">Choose files no larger than {limitLabel}.</p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={oversized}
              onClick={() => {
                startUploads(files, destination.current.path, destination.current.machine);
                setConfirmOpen(false);
              }}
            >
              Upload
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

export function TransferPanel() {
  const transfers = useTransferStore((state) => state.transfers);
  const [expanded, setExpanded] = useState(true);
  if (!transfers.length) return null;
  const active = transfers.filter((item) => item.state === "running" || item.state === "queued").length;

  return (
    <section
      aria-label="File transfers"
      className="fixed bottom-[calc(5rem+env(safe-area-inset-bottom))] right-3 z-[var(--z-panel)] w-[min(24rem,calc(100vw-1.5rem))] rounded-lg border bg-popover text-popover-foreground shadow-lg md:bottom-3"
    >
      <div className="flex items-center gap-2 px-3 py-1">
        <button
          type="button"
          className="min-h-10 flex-1 text-left text-sm font-medium"
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          Transfers{active ? ` (${active} active)` : ""}
        </button>
        <Button variant="ghost" size="sm" onClick={clearFinishedTransfers}>Clear finished</Button>
      </div>
      {expanded && (
        <ul className="max-h-64 overflow-auto border-t">
          {transfers.map((item) => {
            const busy = item.state === "running" || item.state === "queued";
            const name = item.path.split("/").pop();
            const Icon = item.direction === "upload" ? Upload : Download;
            const status = item.state === "done"
              ? item.direction === "download" ? "Sent to browser" : "Uploaded"
              : item.state;
            return (
              <li key={item.id} className="border-b px-3 py-2 last:border-0">
                <div className="flex items-center gap-2">
                  <Icon className="h-4 w-4 shrink-0" aria-hidden />
                  <span className="min-w-0 flex-1 truncate text-sm" title={item.path}>{name}</span>
                  {busy && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-10 w-10"
                      aria-label={`Cancel ${name}`}
                      onClick={() => cancelTransfer(item.id)}
                    >
                      <X className="h-4 w-4" aria-hidden />
                    </Button>
                  )}
                </div>
                <p className="truncate text-xs text-muted-foreground" title={`${item.machineName}: ${item.path}`}>
                  {item.machineName} · <span role="status">{status}</span>
                </p>
                {busy && (
                  <>
                    <progress
                      className="mt-2 h-1.5 w-full accent-primary"
                      aria-label={`Progress for ${name}`}
                      max={item.total || undefined}
                      value={item.total ? item.bytes : undefined}
                    />
                    <p className="text-xs tabular-nums text-muted-foreground">
                      {formatFileSize(item.bytes)}{item.total ? ` / ${formatFileSize(item.total)}` : ""}
                    </p>
                  </>
                )}
                {item.state === "failed" && (
                  <p role="alert" className="mt-1 text-xs text-destructive">{item.error}</p>
                )}
                {item.state === "cancelled" && item.direction === "upload" && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    Stopped. Check destination if upload was finishing.
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
