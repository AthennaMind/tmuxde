"use client";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@repo/ui/components/ui/alert-dialog";

/**
 * "Forget on this device", asked once rather than three times differently.
 *
 * ## Why this is a component and not three copies of a dialog
 *
 * There were three surfaces that could destroy a machine's device keys, and one
 * of them — the session card, the one people actually use — did it on a single
 * menu tap with no confirmation at all, while the other two confirmed. The
 * divergence is not a coincidence: the dialog was copied, and the copy that
 * came last never got one. Extracting it means the confirm *policy* lives in
 * one place, so the next surface cannot quietly opt out of it.
 *
 * What is being destroyed matters: the keys are only on this device, and there
 * is no server-side copy to restore them from. Re-pairing is cheap, but it
 * requires physical access to the machine — which is exactly the thing someone
 * on a phone in a train does not have.
 */
export const FORGET_MACHINE_TITLE = (name: string) =>
  `Forget ${name} on this device?`;

/** The same words wherever it is asked, including the terminal's sheet. */
export const FORGET_MACHINE_BODY =
  "This browser deletes its keys for that machine. The machine keeps running, " +
  "stays on your account, and your other devices are untouched — you can pair " +
  "with it again from here whenever you like.";

export function ForgetMachineDialog({
  machineName,
  onOpenChange,
  onConfirm,
}: {
  /** Non-null is what opens the dialog, so the name can never be blank. */
  machineName: string | null;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog
      open={machineName !== null}
      onOpenChange={(open) => onOpenChange(open)}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {FORGET_MACHINE_TITLE(machineName ?? "this machine")}
          </AlertDialogTitle>
          <AlertDialogDescription>{FORGET_MACHINE_BODY}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel className="h-11">Keep it</AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => {
              e.preventDefault();
              onConfirm();
            }}
            className="h-11 bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            Forget it
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/**
 * The louder one: the machine leaves the account entirely.
 *
 * Distinct from forgetting, and the distinction is the feature — this one
 * reaches every device on the account, not just this browser.
 */
export function RemoveMachineDialog({
  machineName,
  busy,
  onOpenChange,
  onConfirm,
}: {
  machineName: string | null;
  busy: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog
      open={machineName !== null}
      onOpenChange={(open) => {
        if (!busy) onOpenChange(open);
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Remove {machineName}?</AlertDialogTitle>
          <AlertDialogDescription>
            It disappears from this list and any device trusted through it loses
            access. Nothing on the machine itself is changed — running{" "}
            <code className="font-mono">mtmux</code> there registers it again.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy} className="h-11">
            Keep it
          </AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => {
              e.preventDefault();
              onConfirm();
            }}
            disabled={busy}
            className="h-11 bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {busy ? "Removing…" : "Remove"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
