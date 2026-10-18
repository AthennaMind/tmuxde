import { useCallback, useEffect, useState } from "react";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Fingerprint, Loader2, Lock } from "lucide-react";
import { toast } from "sonner";
import { wipe } from "@/crypto";
import {
  eraseDevice,
  readLockRecord,
  unlockWithFactorKey,
  unlockWithPin,
  type LockRecord,
} from "@/lib/lock-store";
import { duringCeremony } from "@/lib/lock-controller";
import { evaluatePrf, prfSupport } from "@/lib/passkey-prf";
import { PinPad } from "./pin-pad";

/**
 * The whole app while locked.
 *
 * Rendered *instead of* the terminal subtree, never over it — the xterm
 * scrollback has to be garbage-collected rather than merely covered, or the
 * lock is a CSS overlay with the shell still in the DOM one devtools panel
 * away.
 */
export function LockScreen({ onUnlocked }: { onUnlocked: () => void }) {
  const [record, setRecord] = useState<LockRecord | null>(null);
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [waitUntil, setWaitUntil] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [confirmingErase, setConfirmingErase] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [erasing, setErasing] = useState(false);

  /**
   * `eraseDevice()` needs no master key, and must not — the failed-unlock wipe
   * path calls it at the exact moment there is none. That is why the deliberate
   * gate is the typed word above rather than anything in the store.
   */
  async function handleErase() {
    if (confirmText.trim().toUpperCase() !== "ERASE") return;
    setErasing(true);
    await eraseDevice();
    window.location.href = "/login";
  }

  useEffect(() => {
    void readLockRecord().then((r) => {
      setRecord(r);
      if (r?.lockedUntil && r.lockedUntil > Date.now()) {
        setWaitUntil(r.lockedUntil);
      }
    });
  }, []);

  // Ticks only while there is a countdown to show.
  useEffect(() => {
    if (!waitUntil) return;
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, [waitUntil]);

  const throttled = waitUntil !== null && waitUntil > now;

  const submit = useCallback(
    async (value: string) => {
      setBusy(true);
      try {
        const outcome = await unlockWithPin(value);
        if (outcome.ok) {
          onUnlocked();
          return;
        }
        setPin("");
        if (outcome.reason === "throttled") {
          setWaitUntil(outcome.until);
          return;
        }
        if (outcome.reason === "wiped") {
          toast.error("Too many attempts. This device has been erased.");
          window.location.href = "/login";
          return;
        }
        if (outcome.reason === "no-lock") {
          onUnlocked();
          return;
        }
        const fresh = await readLockRecord();
        if (fresh?.lockedUntil && fresh.lockedUntil > Date.now()) {
          setWaitUntil(fresh.lockedUntil);
        }
        toast.error(
          outcome.attemptsLeft === null
            ? "Wrong PIN."
            : `Wrong PIN. ${outcome.attemptsLeft} left before this device erases itself.`,
        );
      } finally {
        setBusy(false);
      }
    },
    [onUnlocked],
  );

  async function unlockWithPasskey(factorId: string) {
    setBusy(true);
    try {
      const secret = await duringCeremony(() => evaluatePrf(factorId));
      if (!secret) {
        toast.error("That did not produce a key. Use your PIN.");
        return;
      }
      const outcome = await unlockWithFactorKey(factorId, secret);
      wipe(secret);
      if (outcome.ok) onUnlocked();
      else toast.error("That passkey does not open this device.");
    } finally {
      setBusy(false);
    }
  }

  const passkey = record?.factors.find((f) => f.kind === "passkey");
  // Recorded at enrollment so the dots match what was chosen. The digit count
  // is not a secret — hiding it would only mean the pad silently accepts more
  // digits than it draws.
  const length = record?.pinLength ?? 6;

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-6 bg-background px-6">
      <div className="flex flex-col items-center gap-3 text-center">
        <span className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
          <Lock className="h-5 w-5 text-muted-foreground" aria-hidden />
        </span>
        <h1 className="text-lg font-medium text-foreground">Locked</h1>
        <p className="max-w-xs text-sm text-muted-foreground">
          Your keys are encrypted on this device. Nothing on the machine was
          stopped — your sessions are still running.
        </p>
      </div>

      <div className="w-full max-w-xs">
        <PinPad
          length={length}
          value={pin}
          onChange={setPin}
          onComplete={(value) => void submit(value)}
          disabled={busy || throttled}
          label="Enter your PIN"
          autoFocus
        />
        {busy && (
          <p className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            Checking…
          </p>
        )}
        {throttled && (
          <p
            role="status"
            className="text-center text-sm text-muted-foreground"
          >
            Too many attempts. Try again in{" "}
            {Math.ceil((waitUntil - now) / 1000)}s.
          </p>
        )}
      </div>

      {passkey && prfSupport() === "available" && (
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => void unlockWithPasskey(passkey.id)}
        >
          <Fingerprint className="h-4 w-4" aria-hidden />
          Use a passkey
        </Button>
      )}

      {/*
        The escape hatch. Without an erase from this screen, forgetting a PIN
        leaves a browser profile that cannot be used again.

        Erasing destroys only what is in this browser. The sessions on the
        machine keep running, and signing in again takes only the token.
      */}
      <div className="max-w-xs space-y-2 text-center">
        <p className="text-xs text-muted-foreground">
          Forgotten it? There is no reset — the PIN is the key, and nothing else
          can unwrap it.
        </p>
        <Button
          variant="ghost"
          size="sm"
          disabled={busy || erasing}
          className="text-xs text-muted-foreground hover:text-destructive"
          onClick={() => setConfirmingErase(true)}
        >
          Erase this device and start over
        </Button>
      </div>

      <AlertDialog
        open={confirmingErase}
        onOpenChange={(open) => {
          if (!open && !erasing) setConfirmingErase(false);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Erase this device?</AlertDialogTitle>
            <AlertDialogDescription>
              This browser forgets its token, and the lock goes with it.
              Nothing on the machine changes. Your sessions keep running, and
              signing in again takes only the token.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-2">
            <Label htmlFor="lock-erase-confirm" className="text-xs">
              Type ERASE to confirm
            </Label>
            <Input
              id="lock-erase-confirm"
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              autoComplete="off"
              autoCapitalize="characters"
              placeholder="ERASE"
            />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={erasing} className="h-11">
              Keep trying
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void handleErase();
              }}
              disabled={erasing || confirmText.trim().toUpperCase() !== "ERASE"}
              className="h-11 bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {erasing ? "Erasing…" : "Erase this device"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
