"use client";

import { useState } from "react";
import Link from "next/link";
import { Check, KeyRound, Loader2, X } from "lucide-react";
import { Button } from "@repo/ui/components/ui/button";
import { cn } from "@repo/ui/lib/utils";
import { toast } from "sonner";
import { authClient } from "@/lib/auth-client";
import type { OnboardingState, OnboardingStep } from "@/hooks/use-onboarding";

/**
 * The first thing a new account sees, and the only thing that connects
 * "you signed in" to "you have a terminal open".
 *
 * Before this, a fresh account landed on an empty machine list whose one
 * suggestion was to install a CLI — with the step that actually matters,
 * asking a machine to let this browser in, hidden behind a button on a card
 * that only appears once a machine exists. So the strongest account-only
 * capability was the least discoverable thing in the product.
 *
 * Each row has one action and it is the real one: the passkey enrols here, the
 * pairing dialog is the same dialog the card opens. Nothing here is a link to
 * documentation about doing the thing.
 */
export function GettingStarted({
  state,
  onPair,
  installSlot,
  className,
}: {
  state: OnboardingState;
  /** Opens the same `RequestAccessDialog` the machine cards use. */
  onPair: () => void;
  /** `<InstallMachine withLogin />`, passed in so this file owns no copy of it. */
  installSlot: React.ReactNode;
  className?: string;
}) {
  if (!state.visible) return null;

  return (
    <section
      aria-labelledby="getting-started-heading"
      className={cn(
        "mb-6 rounded-lg border border-border bg-muted/30 p-4 sm:p-5",
        className,
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2
            id="getting-started-heading"
            className="text-base font-medium text-foreground"
          >
            Getting set up
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {state.doneCount} of {state.steps.length} done. Nothing here is
            required — mtmux pairs without an account too.
          </p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="h-8 shrink-0 text-muted-foreground"
          onClick={state.dismiss}
        >
          <X className="h-4 w-4" aria-hidden />
          Dismiss
        </Button>
      </div>

      <ol className="mt-4 space-y-3">
        {state.steps.map((step, index) => (
          <StepRow
            key={step.id}
            step={step}
            index={index}
            isNext={state.next?.id === step.id}
            onPair={onPair}
            installSlot={installSlot}
          />
        ))}
      </ol>
    </section>
  );
}

function StepRow({
  step,
  index,
  isNext,
  onPair,
  installSlot,
}: {
  step: OnboardingStep;
  index: number;
  isNext: boolean;
  onPair: () => void;
  installSlot: React.ReactNode;
}) {
  return (
    <li className="flex gap-3">
      <span
        aria-hidden
        className={cn(
          "mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full border text-xs font-medium",
          step.done
            ? "border-primary/40 bg-primary/10 text-primary"
            : isNext
              ? "border-primary/60 text-primary"
              : "border-border text-muted-foreground",
        )}
      >
        {step.done ? <Check className="h-3.5 w-3.5" /> : index + 1}
      </span>

      <div className="min-w-0 flex-1">
        <p
          className={cn(
            "text-sm font-medium",
            step.done ? "text-muted-foreground line-through" : "text-foreground",
          )}
        >
          {step.title}
        </p>
        {!step.done && (
          <p className="mt-0.5 text-sm leading-relaxed text-muted-foreground">
            {step.body}
          </p>
        )}

        {/* Only the *next* step gets its control. Four open actions at once is
            a form, not a checklist, and it hides which one to do now. */}
        {!step.done && isNext && (
          <div className="mt-3">
            {step.id === "credential" && <AddPasskey />}
            {step.id === "machine" && installSlot}
            {step.id === "pair" && (
              <Button className="h-11" onClick={onPair}>
                Ask a machine to let this browser in
              </Button>
            )}
            {step.id === "session" && (
              <Button asChild className="h-11">
                <Link href="/">Open the terminal</Link>
              </Button>
            )}
          </div>
        )}
      </div>
    </li>
  );
}

/**
 * Enrol a passkey without leaving the page.
 *
 * A passkey is a second *credential*, not account recovery — losing the only
 * device holding one leaves you in the same hole, while believing you are safe.
 * The copy in `use-onboarding.ts` says so, and `security-panel.tsx` says it at
 * greater length where the whole set of methods is on screen.
 */
function AddPasskey() {
  const [busy, setBusy] = useState(false);

  async function add() {
    setBusy(true);
    try {
      const result = await authClient.passkey.addPasskey();
      // better-auth reports a declined or unsupported ceremony in `error`
      // rather than by throwing, so a bare try/catch would call a cancelled
      // prompt a success and tick the step.
      if (result?.error) {
        toast.error(result.error.message ?? "That passkey was not added.");
        return;
      }
      toast.success("Passkey added");
      // The step reads `listUserPasskeys()` on mount. A reload is blunt, but it
      // is one line against a second fetch path that could disagree with the
      // security panel about what this account has.
      window.location.reload();
    } catch {
      toast.error("That passkey was not added.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button className="h-11" disabled={busy} onClick={() => void add()}>
      {busy ? (
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
      ) : (
        <KeyRound className="h-4 w-4" aria-hidden />
      )}
      Add a passkey
    </Button>
  );
}

/**
 * The credential ask, once the checklist is gone.
 *
 * Separate dismissal, separate key: someone who dismissed a four-step checklist
 * did not necessarily decide their account needs only one way in.
 */
export function SecondCredentialBanner({ state }: { state: OnboardingState }) {
  if (!state.showCredentialBanner) return null;

  return (
    <div className="mb-6 flex flex-wrap items-center gap-3 rounded-lg border border-border bg-muted/30 px-4 py-3">
      <KeyRound className="h-4 w-4 shrink-0 text-primary" aria-hidden />
      <p className="min-w-0 flex-1 text-sm text-muted-foreground">
        This account has one way in. Add a passkey so a lost password is not the
        end of it.
      </p>
      <div className="flex gap-2">
        <Button asChild size="sm" variant="outline" className="h-9">
          <Link href="/settings/security">Add one</Link>
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-9 text-muted-foreground"
          onClick={state.dismissCredentialBanner}
        >
          Not now
        </Button>
      </div>
    </div>
  );
}
