import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@repo/ui/components/ui/button";
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
import { disconnectDevice } from "@/lib/sign-out";
import { SettingsRow, SettingsSection } from "./settings-rows";

/**
 * Sign this browser out of the machine.
 *
 * `disconnectDevice()` existed with nothing calling it, so the only way to
 * drop the token was "Erase this device", which needs a PIN first. A token
 * is all it takes to sign in again, but it may sit on a machine the user is
 * not at, so the button asks once.
 */
export function DisconnectSection() {
  const [confirming, setConfirming] = useState(false);
  const [leaving, setLeaving] = useState(false);

  async function disconnect() {
    setLeaving(true);
    try {
      // Navigates to /login when done.
      await disconnectDevice();
    } catch (err) {
      setLeaving(false);
      toast.error((err as Error).message || "Could not disconnect");
    }
  }

  return (
    <SettingsSection title="Connection">
      <SettingsRow
        label="Disconnect"
        hint="Signs this browser out. You sign in again with the relay token. Your tmux sessions keep running."
        textLabel
      >
        {() => (
          <Button
            size="sm"
            variant="outline"
            className="pointer-coarse:h-11"
            onClick={() => setConfirming(true)}
          >
            Disconnect
          </Button>
        )}
      </SettingsRow>

      <AlertDialog
        open={confirming}
        onOpenChange={(open) => {
          if (!open && !leaving) setConfirming(false);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Disconnect this browser?</AlertDialogTitle>
            <AlertDialogDescription>
              The relay token is removed from this browser. You need it to
              sign in again. Your tmux sessions keep running.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={leaving}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={leaving}
              onClick={(event) => {
                // Stay open while it runs. The page navigates away after.
                event.preventDefault();
                void disconnect();
              }}
            >
              {leaving ? "Disconnecting…" : "Disconnect"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SettingsSection>
  );
}
