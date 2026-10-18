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
import { toast } from "sonner";
import { wipe } from "@/crypto";
import {
  addFactor,
  eraseDevice,
  readLockRecord,
  removeFactor,
  updateLockSettings,
  type LockRecord,
} from "@/lib/lock-store";
import { duringCeremony, lockNow } from "@/lib/lock-controller";
import { enrollPasskeyFactor, prfSupport } from "@/lib/passkey-prf";
import { isEnrolled, isUnlocked } from "@/lib/unlocked";
import {
  Segmented,
  SettingsRow,
  SettingsSection,
  SwitchRow,
} from "@/components/settings/settings-rows";
import { LockEnrollDialog } from "./lock-enroll-dialog";

const IDLE_OPTIONS = [1, 5, 15, 60, 0] as const;

function idleLabel(minutes: number): string {
  if (minutes === 0) return "Never";
  if (minutes < 60) return `${minutes} min`;
  return "1 hour";
}

/** The lock's settings, wherever the app decides to show them. */
export function LockSettings() {
  const [record, setRecord] = useState<LockRecord | null>(null);
  const [enrolling, setEnrolling] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmingErase, setConfirmingErase] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [erasing, setErasing] = useState(false);

  const refresh = useCallback(async () => {
    setRecord(await readLockRecord());
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function patch(next: Partial<LockRecord>) {
    await updateLockSettings(next);
    await refresh();
  }

  async function addPasskey() {
    setBusy(true);
    try {
      const result = await duringCeremony(() => enrollPasskeyFactor("tmuxde device lock"));
      if (!result.ok) {
        toast.error(
          result.reason === "no-prf"
            ? "That authenticator cannot derive a key. Remove the unused passkey it created in your device settings."
            : "Could not add that passkey.",
        );
        return;
      }
      await addFactor("passkey", result.secret, { label: "Passkey" });
      wipe(result.secret);
      await refresh();
      toast.success("Passkey added.");
    } finally {
      setBusy(false);
    }
  }

  async function drop(id: string) {
    try {
      await removeFactor(id);
      await refresh();
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  /**
   * Typed confirmation, not `window.confirm`.
   *
   * This is the one irreversible action in the app — there is no recovery by
   * construction — and a native confirm is one stray Return away from taken.
   * Requiring the word makes the gesture deliberate, and it is the only gate
   * left now that `eraseDevice()` itself stays master-key-free: it has to be,
   * because the failed-unlock wipe path calls it at the exact moment no master
   * key exists.
   */
  async function erase() {
    if (confirmText.trim().toUpperCase() !== "ERASE") return;
    setErasing(true);
    await eraseDevice();
    window.location.href = "/login";
  }

  /**
   * Defence in depth: render nothing actionable on a locked device.
   *
   * The terminal routes sit behind `LockGate`, so this should be unreachable.
   * It stays because this component is mounted from `SettingsPanel`, which any
   * future page can pull in without noticing it needs a gate. `removeFactor`
   * and `updateLockSettings` throw on their own now. This just means a locked
   * device is never shown controls that would.
   */
  if (isEnrolled() && !isUnlocked()) {
    return (
      <SettingsSection
        title="Device lock"
        description="This device is locked. Unlock it to change these settings."
      />
    );
  }

  if (!record || !isEnrolled()) {
    return (
      <SettingsSection
        title="Device lock"
        description="Encrypt the keys saved in this browser behind a PIN. Someone holding your unlocked phone then cannot reach your terminal."
      >
        <SettingsRow label="PIN" hint="Not set" textLabel>
          {() => (
            <Button size="sm" className="pointer-coarse:h-11" onClick={() => setEnrolling(true)}>
              Set a PIN
            </Button>
          )}
        </SettingsRow>
        <LockEnrollDialog
          open={enrolling}
          onOpenChange={setEnrolling}
          onEnrolled={() => void refresh()}
        />
      </SettingsSection>
    );
  }

  const passkeys = record.factors.filter((f) => f.kind === "passkey");
  const support = prfSupport();

  return (
    <SettingsSection title="Device lock">
      <SettingsRow label="Lock after" hint="Time without input before the app locks." textLabel>
        {(ids) => (
          <Segmented
            ids={ids}
            value={record.idleMinutes}
            onChange={(minutes) => void patch({ idleMinutes: minutes })}
            options={IDLE_OPTIONS.map((minutes) => ({
              value: minutes,
              label: idleLabel(minutes),
            }))}
          />
        )}
      </SettingsRow>

      <SwitchRow
        label="Lock when I switch apps"
        hint="Off by default on phones. iOS counts the app switcher, the share sheet and the Face ID prompt as leaving the app."
        checked={record.lockOnBackground}
        onChange={(v) => void patch({ lockOnBackground: v })}
      />

      <SwitchRow
        label="Erase after 10 wrong PINs"
        hint="Off by default. A child mashing the pad is more likely than the attack this stops. Anyone who copied this browser's storage is not typing into it anyway."
        checked={record.wipeAfter10}
        onChange={(v) => void patch({ wipeAfter10: v })}
      />

      <SettingsRow
        label="Passkeys"
        hint="The only factor that also protects a copy of this browser's storage taken elsewhere."
        stacked
        textLabel
      >
        {() => (
          <div className="space-y-2">
            {passkeys.length > 0 && (
              <ul className="space-y-1.5">
                {passkeys.map((factor) => {
                  const added = new Date(factor.createdAt).toLocaleDateString();
                  return (
                    <li
                      key={factor.id}
                      className="flex items-center justify-between gap-3 rounded-md border border-line-subtle bg-surface-sunken ps-3 pe-1 py-1"
                    >
                      <span className="min-w-0 truncate text-[13px] text-foreground">
                        {factor.label ?? "Passkey"}
                        <span className="text-muted-foreground">, added {added}</span>
                      </span>
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={`Remove ${factor.label ?? "passkey"} added ${added}`}
                        className="shrink-0 text-destructive hover:bg-destructive/10 hover:text-destructive pointer-coarse:h-11"
                        onClick={() => void drop(factor.id)}
                      >
                        Remove
                      </Button>
                    </li>
                  );
                })}
              </ul>
            )}
            {support === "available" ? (
              <Button
                size="sm"
                variant="outline"
                className="pointer-coarse:h-11"
                disabled={busy}
                onClick={() => void addPasskey()}
              >
                Add a passkey
              </Button>
            ) : (
              <p className="text-[13px] leading-5 text-muted-foreground">
                {support === "insecure-context"
                  ? "Passkeys need HTTPS. Open tmuxde at its https:// address to add one."
                  : "This browser does not support passkeys."}
              </p>
            )}
          </div>
        )}
      </SettingsRow>

      <SettingsRow label="Lock now" hint="Your tmux sessions keep running." textLabel>
        {() => (
          <Button
            size="sm"
            variant="outline"
            className="pointer-coarse:h-11"
            onClick={() => lockNow("manual")}
          >
            Lock now
          </Button>
        )}
      </SettingsRow>

      <SettingsRow
        label="Erase this device"
        hint="Removes every key and the lock from this browser. You sign in again with the relay token."
        textLabel
      >
        {() => (
          <Button
            size="sm"
            variant="outline"
            className="border-destructive/50 text-destructive hover:bg-destructive/10 hover:text-destructive pointer-coarse:h-11"
            onClick={() => {
              setConfirmText("");
              setConfirmingErase(true);
            }}
          >
            Erase this device
          </Button>
        )}
      </SettingsRow>

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
              Every key and cached session list in this browser goes, along with the lock itself.
              There is no recovery. You sign in again with the relay token. Your tmux sessions keep
              running.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-2">
            <Label htmlFor="erase-confirm" className="text-xs">
              Type ERASE to confirm
            </Label>
            <Input
              id="erase-confirm"
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              autoComplete="off"
              autoCapitalize="characters"
              placeholder="ERASE"
            />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={erasing} className="h-11">
              Keep it
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void erase();
              }}
              disabled={erasing || confirmText.trim().toUpperCase() !== "ERASE"}
              className="h-11 bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {erasing ? "Erasing…" : "Erase this device"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SettingsSection>
  );
}
