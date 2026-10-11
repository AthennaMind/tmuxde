"use client";

import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@repo/ui/components/ui/dialog";
import { Button } from "@repo/ui/components/ui/button";
import { cn } from "@repo/ui/lib/utils";
import { Fingerprint, Loader2, ShieldAlert } from "lucide-react";
import { toast } from "sonner";
import { addFactor, enrollPin } from "@/lib/lock-store";
import { duringCeremony } from "@/lib/lock-controller";
import { enrollPasskeyFactor, prfSupport } from "@/lib/passkey-prf";
import { wipe } from "@repo/crypto";
import { PinPad } from "./pin-pad";

/**
 * Choose a PIN, then optionally add a passkey.
 *
 * ## Where the recovery copy goes
 *
 * Above the PIN entry, before the first keystroke — not in a toast afterwards.
 * There is no recovery, by construction, and mtmux is the rare product where
 * that is fine: re-pairing is running `mtmux` and typing one code. Someone
 * needs to know that *while deciding*, not after they have forgotten the PIN.
 *
 * ## Why the entropy numbers are on the buttons
 *
 * Because they are unflattering and true. A 6-digit PIN behind PBKDF2-600k
 * exhausts in about a minute on one consumer GPU. It stops a person holding
 * your unlocked phone — which is the realistic threat and the reason to have
 * it — and does not stop someone who copies the database. Saying "secure" here
 * instead of a number would be selling the wrong thing.
 */

const PIN_LENGTHS = [
  { digits: 4, note: "10,000 combinations — about a second offline" },
  { digits: 6, note: "1,000,000 — about a minute offline" },
  { digits: 8, note: "100,000,000 — a couple of hours offline" },
] as const;

type Step = "pin" | "confirm" | "passkey";

export function LockEnrollDialog({
  open,
  onOpenChange,
  onEnrolled,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onEnrolled?: () => void;
}) {
  const [length, setLength] = useState(6);
  const [step, setStep] = useState<Step>("pin");
  const [pin, setPin] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const support = prfSupport();

  function reset() {
    setStep("pin");
    setPin("");
    setConfirm("");
    setBusy(false);
  }

  async function commit(confirmed: string) {
    if (confirmed !== pin) {
      toast.error("Those did not match. Try again.");
      setConfirm("");
      return;
    }
    setBusy(true);
    try {
      await enrollPin(pin);
      setStep("passkey");
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function addPasskey() {
    setBusy(true);
    try {
      // The visibility events fired by the platform's own prompt must not be
      // read as "the user backgrounded the app".
      const result = await duringCeremony(() =>
        enrollPasskeyFactor("mtmux device lock"),
      );
      if (result.ok) {
        await addFactor("passkey", result.secret, { label: "Passkey" });
        wipe(result.secret);
        toast.success("Passkey added.");
        finish();
        return;
      }
      if (result.reason === "no-prf") {
        // There is no API to delete a credential that was just created. Saying
        // so is the only honest option — the alternative is a stray passkey
        // the user cannot explain.
        toast.error(
          "That authenticator cannot derive a key. The passkey it just created is unused — you will have to remove it from your device's settings yourself. Your PIN still works.",
        );
      } else if (result.reason === "unsupported") {
        toast.error("This browser or origin cannot use passkeys.");
      }
      finish();
    } catch (err) {
      toast.error((err as Error).message);
      setBusy(false);
    }
  }

  function finish() {
    setBusy(false);
    onEnrolled?.();
    onOpenChange(false);
    reset();
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-md">
        {step === "pin" && (
          <>
            <DialogHeader>
              <DialogTitle>Lock this device</DialogTitle>
              <DialogDescription>
                Your keys are encrypted with this PIN and only decrypted while
                you are using them.
              </DialogDescription>
            </DialogHeader>

            <p className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 p-3 text-sm text-foreground">
              <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              <span>
                <strong>There is no way to reset this PIN.</strong> Forget it
                and this browser has to sign in again with the relay token.
                Nothing on the machine is lost.
              </span>
            </p>

            <div className="space-y-2">
              {PIN_LENGTHS.map((option) => (
                <button
                  key={option.digits}
                  type="button"
                  onClick={() => {
                    setLength(option.digits);
                    setPin("");
                  }}
                  aria-pressed={length === option.digits}
                  className={cn(
                    "flex w-full items-baseline gap-3 rounded-md border p-3 text-left",
                    length === option.digits
                      ? "border-primary bg-primary/10"
                      : "border-border hover:bg-accent",
                  )}
                >
                  <span className="text-sm font-medium">
                    {option.digits} digits
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {option.note}
                  </span>
                </button>
              ))}
            </div>

            <PinPad
              length={length}
              value={pin}
              onChange={setPin}
              onComplete={() => setStep("confirm")}
              label="Choose a PIN"
              autoFocus
            />
          </>
        )}

        {step === "confirm" && (
          <>
            <DialogHeader>
              <DialogTitle>Type it again</DialogTitle>
              <DialogDescription>
                So a slip now does not lock you out later.
              </DialogDescription>
            </DialogHeader>
            <PinPad
              length={length}
              value={confirm}
              onChange={setConfirm}
              onComplete={(value) => void commit(value)}
              disabled={busy}
              label="Confirm your PIN"
              autoFocus
            />
            {busy && (
              <p className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                Encrypting your keys…
              </p>
            )}
          </>
        )}

        {step === "passkey" && (
          <>
            <DialogHeader>
              <DialogTitle>Add a passkey too?</DialogTitle>
              <DialogDescription>
                A PIN stops someone picking up your phone. A passkey is the only
                factor that also stops someone who copies this browser&apos;s
                storage and takes it away — its secret has 256 bits of entropy
                and never leaves your device.
              </DialogDescription>
            </DialogHeader>

            {support === "available" ? (
              <>
                <p className="rounded-md border border-border bg-muted/40 p-3 text-sm text-muted-foreground">
                  <strong className="text-foreground">
                    You will be asked twice.
                  </strong>{" "}
                  Creating the passkey and reading its key are two separate
                  prompts — that is how the standard works, not a bug.
                </p>
                <DialogFooter className="gap-2 sm:justify-between">
                  <Button variant="ghost" onClick={finish} disabled={busy}>
                    Not now
                  </Button>
                  <Button onClick={() => void addPasskey()} disabled={busy}>
                    {busy ? (
                      <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                    ) : (
                      <Fingerprint className="h-4 w-4" aria-hidden />
                    )}
                    Add a passkey
                  </Button>
                </DialogFooter>
              </>
            ) : (
              <>
                <p className="text-sm text-muted-foreground">
                  {support === "insecure-context"
                    ? "Passkeys need HTTPS. Open your local HTTPS address to add one."
                    : "This browser does not support passkeys."}{" "}
                  Your PIN is set and working.
                </p>
                <DialogFooter>
                  <Button onClick={finish}>Done</Button>
                </DialogFooter>
              </>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
