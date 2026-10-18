import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import { readLockRecord, unlockWithPin } from "./lock-store";
import { PinPad } from "./pin-pad";

/**
 * Re-ask for the PIN before opening a session marked "require unlock".
 *
 * The device is already unlocked when this appears — the point is the gap
 * between "I handed someone my phone" and "they opened the production shell".
 * The UI never calls that session *protected* or *secured*, because it is
 * neither: anyone with a devtools console on this unlocked device can call
 * `getRelayClient().send({ type: "session:attach", … })` directly. It is a
 * privacy control against a person in the room, and it is labelled as one.
 *
 * Verification reuses `unlockWithPin`, so the throttle, the wipe counter and
 * the derivation are the same ones the lock screen uses — a second
 * implementation is a second thing to get out of step.
 */
export function RequireUnlockDialog({
  open,
  onOpenChange,
  sessionName,
  onUnlocked,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessionName: string;
  onUnlocked: () => void;
}) {
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [length, setLength] = useState(6);

  async function submit(value: string) {
    setBusy(true);
    try {
      const outcome = await unlockWithPin(value);
      setPin("");
      if (outcome.ok) {
        onOpenChange(false);
        onUnlocked();
        return;
      }
      toast.error(
        outcome.reason === "throttled" ? "Too many attempts. Wait a moment." : "Wrong PIN.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setPin("");
        onOpenChange(next);
      }}
    >
      <DialogContent
        className="sm:max-w-xs"
        onOpenAutoFocus={() => {
          void readLockRecord().then((r) => setLength(r?.pinLength ?? 6));
        }}
      >
        <DialogHeader>
          <DialogTitle>Enter your PIN</DialogTitle>
          <DialogDescription>
            You asked to be re-prompted before opening{" "}
            <span className="font-mono">{sessionName}</span>.
          </DialogDescription>
        </DialogHeader>
        <PinPad
          length={length}
          value={pin}
          onChange={setPin}
          onComplete={(value) => void submit(value)}
          disabled={busy}
          label="Enter your PIN"
          autoFocus
        />
      </DialogContent>
    </Dialog>
  );
}
