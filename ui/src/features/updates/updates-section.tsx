import { useEffect, useRef, useState } from "react";
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
import type { UpdateStatus } from "@/protocol/updates";
import {
  cancelUpdate,
  checkForUpdates,
  getUpdateStatus,
  startUpdate,
} from "@/features/connection/updates-api";
import { SettingsSection } from "@/features/settings/settings-rows";

const phaseLabels: Record<string, string> = {
  pending: "Pending",
  downloading: "Downloading",
  verifying: "Verifying",
  staged: "Ready to install",
  starting: "Starting update",
  installing: "Installing",
  restarting: "Restarting",
  "rolling-back": "Restoring previous version",
  "awaiting-reconnect": "Waiting for reconnect",
  updated: "Updated",
  failed: "Failed",
  "rolled-back": "Previous version restored",
  "rollback-failed": "Manual recovery required",
  cancelled: "Cancelled",
  interrupted: "Interrupted",
};

export function UpdatesSection() {
  const [state, setState] = useState<UpdateStatus | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [confirm, setConfirm] = useState<string[]>([]);
  const lifetime = useRef<AbortController | null>(null);
  const requestID = useRef<string | null>(null);
  const active = state?.job?.active ?? false;

  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    void getUpdateStatus(controller.signal)
      .then(setState)
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) setError(message(reason));
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        setState(await getUpdateStatus(controller.signal));
        setError("");
      } catch {
        if (!controller.signal.aborted) setError("Reconnecting to read update progress…");
      }
      if (!controller.signal.aborted) timer = setTimeout(() => void refresh(), 2000);
    };
    timer = setTimeout(() => void refresh(), 2000);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [active]);

  const check = async () => {
    setBusy(true);
    setChecking(true);
    setError("");
    try {
      setState(await checkForUpdates(lifetime.current?.signal));
      setSelected([]);
    } catch (reason) {
      setError(message(reason));
    } finally {
      setBusy(false);
      setChecking(false);
    }
  };

  const install = async () => {
    if (!state?.snapshot) return;
    setBusy(true);
    setError("");
    requestID.current ??= crypto.randomUUID();
    try {
      const job = await startUpdate(
        requestID.current,
        state.snapshot.id,
        confirm,
        lifetime.current?.signal,
      );
      setState({ ...state, job });
      setSelected([]);
      requestID.current = null;
    } catch (reason) {
      setError(message(reason));
      // A lost response may hide an accepted job. Read state, never replay install.
      try {
        setState(await getUpdateStatus(lifetime.current?.signal));
      } catch {
        /* Keep original error. */
      }
    } finally {
      setConfirm([]);
      setBusy(false);
    }
  };

  const cancel = async () => {
    if (!state?.job) return;
    setBusy(true);
    try {
      setState(await cancelUpdate(state.job.id, lifetime.current?.signal));
    } catch (reason) {
      setError(message(reason));
    } finally {
      setBusy(false);
    }
  };

  const cancellable =
    active &&
    state?.job?.items.every((item) =>
      ["pending", "downloading", "verifying", "staged"].includes(item.result.phase),
    );
  const interrupted =
    !active && state?.job?.items.some((item) => item.result.phase === "interrupted");
  const serverUpdated = state?.job?.items.some(
    (item) => item.component.kind === "server" && item.result.phase === "updated",
  );
  const eligibleSelected = selected.filter((id) =>
    state?.components.some((component) => component.id === id && component.eligible),
  );

  return (
    <SettingsSection
      title="Updates"
      description="Check and install updates when you choose. No automatic checks or downloads."
    >
      <div className="flex flex-wrap items-center gap-2 px-4 py-3">
        <Button variant="outline" size="sm" disabled={busy || active} onClick={() => void check()}>
          {checking ? "Checking…" : "Check for updates"}
        </Button>
        {eligibleSelected.length > 0 && (
          <Button
            size="sm"
            disabled={busy || active}
            onClick={() => {
              requestID.current = null;
              setConfirm(eligibleSelected);
            }}
          >
            Update selected ({eligibleSelected.length})
          </Button>
        )}
        {(cancellable || interrupted) && (
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => void cancel()}>
            Cancel update
          </Button>
        )}
        {serverUpdated && !active && (
          <Button variant="outline" size="sm" onClick={() => window.location.reload()}>
            Reload updated UI
          </Button>
        )}
      </div>
      {state?.snapshot && (
        <p className="px-4 py-3 text-xs text-muted-foreground">
          Last checked {new Date(state.snapshot.checked).toLocaleString()}.{" "}
          <a
            className="underline underline-offset-4"
            href={state.snapshot.release.html_url}
            target="_blank"
            rel="noreferrer"
          >
            {state.snapshot.release.tag_name} release notes
          </a>
        </p>
      )}
      {error && (
        <p role="alert" className="px-4 py-3 text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="divide-y divide-border" aria-live="polite">
        {state?.components.map((component) => {
          const item = state.job?.items.find((entry) => entry.component.id === component.id);
          return (
            <div key={component.id} className="flex items-center gap-3 px-4 py-3">
              <input
                type="checkbox"
                aria-label={`Select ${component.name}`}
                className="size-4 accent-primary"
                checked={selected.includes(component.id)}
                disabled={!component.eligible || active || busy}
                onChange={(event) =>
                  setSelected(
                    event.target.checked
                      ? [...selected, component.id]
                      : selected.filter((id) => id !== component.id),
                  )
                }
              />
              <div className="min-w-0 flex-1 space-y-1">
                <p className="truncate text-sm font-medium">{component.name}</p>
                <p className="text-xs text-muted-foreground">
                  {component.version || "Version unknown"}
                  {component.eligible && ` → ${component.available}`}
                  {component.os && ` · ${component.os} ${component.arch}`}
                </p>
                <p className="text-xs text-muted-foreground">
                  {component.reason ||
                    (component.eligible
                      ? `${(component.size / 1048576).toFixed(1)} MB download`
                      : "Check for updates to see available version")}
                </p>
                {item && (
                  <p className="text-xs">
                    {phaseLabels[item.result.phase]}
                    {item.result.message && `: ${item.result.message}`}
                  </p>
                )}
              </div>
              {component.eligible && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={active || busy}
                  onClick={() => {
                    requestID.current = null;
                    setConfirm([component.id]);
                  }}
                >
                  Update
                </Button>
              )}
            </div>
          );
        })}
      </div>
      <AlertDialog
        open={confirm.length > 0}
        onOpenChange={(open) => {
          if (!open && !busy) setConfirm([]);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Install {state?.snapshot?.release.tag_name}?</AlertDialogTitle>
            <AlertDialogDescription>
              {state?.components
                .filter((component) => confirm.includes(component.id))
                .map((component) => component.name)
                .join(", ")}{" "}
              will restart. Connections briefly disconnect while terminal sessions keep running.
              Speech updates pause dictation.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              onClick={(event) => {
                event.preventDefault();
                void install();
              }}
            >
              Update
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SettingsSection>
  );
}

function message(reason: unknown): string {
  return reason instanceof Error ? reason.message : "Update request failed";
}
