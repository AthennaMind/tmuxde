"use client";

import { useEffect, useState } from "react";
import { ShieldQuestion, Loader2 } from "lucide-react";
import { formatSas } from "@repo/crypto";
import { displayLabel } from "@repo/protocol";
import { Button } from "@repo/ui/components/ui/button";
import {
  Dialog,
  DialogContentRaw,
  DialogDescription,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
} from "@repo/ui/components/ui/dialog";
import { getRelayClient } from "@/hooks/use-websocket";
import { useDeviceApprovalStore } from "@/stores/device-approval-store";

/**
 * "A device wants in. Yes or no?" — asked here, on the device you are holding.
 *
 * ## Why this is a modal, and an undismissable one
 *
 * Everything else this app pushes at the user is a banner: transient, ignorable,
 * gone in six seconds. That is right for news and wrong for a decision. A
 * request that expired because a toast faded while the user was reading the
 * terminal is a request they were never actually asked, and the failure is
 * silent on both ends — the machine sees a timeout, the user sees nothing.
 *
 * So it takes the screen, and it cannot be dismissed by tapping outside, by
 * Escape, or by an X in the corner. Not to be obnoxious: because every one of
 * those is a way to *not answer* that looks like answering, and the user would
 * reasonably believe they had refused. There are two ways out and both of them
 * say what they do. "Deny" is one tap, and it is the fastest thing on screen.
 *
 * ## What is on it, and why each thing is there
 *
 * The device label and the account are *who is asking*. The six digits are the
 * only part that proves anything: the requesting browser is showing the same
 * six on its own screen, and they can only differ if something sat in the
 * middle of the key exchange. So the question posed is "do these match?", never
 * "is this code right?" — the user is comparing, not entering.
 *
 * A code pairing carries no digits, and the block is dropped rather than filled
 * with something. The nine-digit code *was* the shared secret, so there is
 * nothing left to compare, and printing six digits nobody can check would teach
 * the eye to nod at the block — including on the requests where checking it is
 * the entire point. The question becomes "did you just type this code?", which
 * is the only thing the user can actually answer.
 *
 * The countdown is there because the request really does expire, and a button
 * that silently stops working is worse than one that says when it will.
 *
 * ## The keyboard
 *
 * Deny holds the initial focus, so the reflex Enter on a laptop refuses. On the
 * one dialog in the product where a stray keypress grants a stranger a shell,
 * the safe answer is the default answer.
 */
export function DeviceApprovalDialog() {
  const request = useDeviceApprovalStore((s) => s.request);
  const answering = useDeviceApprovalStore((s) => s.answering);
  const markAnswering = useDeviceApprovalStore((s) => s.markAnswering);
  const [now, setNow] = useState(() => Date.now());

  // One timer, only while a question is up. A ticking interval behind a closed
  // dialog would re-render the whole shell once a second for nothing.
  useEffect(() => {
    if (!request) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [request]);

  if (!request) return null;

  const remaining = Math.max(0, Math.ceil((request.expiresAt - now) / 1000));

  const answer = (approved: boolean) => {
    if (answering) return;
    markAnswering();
    // Fire and forget. The dialog closes on `device:approval-resolved`, not on
    // this send, so a dropped answer leaves the question visible rather than
    // leaving the user believing they decided something they did not.
    getRelayClient()?.send({
      type: "device:approve",
      id: request.id,
      approved,
    });
  };

  return (
    <Dialog open>
      <DialogPortal>
        <DialogOverlay />
        <DialogContentRaw
          // No ids of our own, and no zoom.
          //
          // Radix wires `aria-labelledby`/`aria-describedby` from the `Title`
          // and `Description` it renders; naming them here overrode the
          // generated ids with ones its context did not know about, which it
          // reports as a missing description — an accessible name silently
          // detached from the element that carries it.
          //
          // The scale-in is gone because this dialog is measured and tapped,
          // not admired: at 95% a 44px button is 41.8px for the length of the
          // animation, which is both a real mis-tap window and what the tap
          // floor detector saw.
          className="fixed left-1/2 top-1/2 z-[var(--z-modal)] w-[calc(100vw-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-lg border bg-background p-5 shadow-lg duration-200 data-[state=open]:animate-in data-[state=open]:fade-in-0 sm:p-6"
          // Three separate ways to leave without answering, all closed. See
          // the header: a dismissal the user reads as a refusal, but which
          // refuses nothing, is the worst outcome this dialog can produce.
          onPointerDownOutside={(e) => e.preventDefault()}
          onInteractOutside={(e) => e.preventDefault()}
          onEscapeKeyDown={(e) => e.preventDefault()}
        >
          <div className="flex items-start gap-3">
            <span
              className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-amber-500/15 text-amber-600 dark:text-amber-400"
              aria-hidden
            >
              <ShieldQuestion className="h-5 w-5" />
            </span>
            <div className="min-w-0">
              <DialogTitle className="text-base font-semibold leading-tight">
                Let this device in?
              </DialogTitle>
              <DialogDescription className="mt-1 text-sm">
                {request.via === "code"
                  ? "Someone just entered this machine's pairing code. Nothing is granted until you say yes."
                  : "It is asking for a shell on this machine. Nothing is granted until you say yes."}
              </DialogDescription>
            </div>
          </div>

          <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-sm">
            <dt className="text-muted-foreground">Device</dt>
            <dd
              className="min-w-0 truncate font-medium"
              title={request.deviceLabel}
            >
              {displayLabel(request.deviceLabel, "unknown device")}
            </dd>
            <dt className="text-muted-foreground">Account</dt>
            <dd
              className="min-w-0 truncate font-medium"
              title={request.accountEmail}
            >
              {displayLabel(request.accountEmail, "not signed in")}
            </dd>
          </dl>

          {request.sas ? (
            <>
              <div
                className="mt-4 rounded-lg border border-border bg-muted/40 py-4 text-center"
                // Read as individual digits. A screen reader saying "four
                // hundred and eight thousand" is useless for a value being
                // compared character by character against another screen.
                aria-label={`Verification digits ${request.sas.split("").join(" ")}`}
                data-testid="approval-sas"
              >
                <span className="font-mono text-3xl tabular-nums tracking-[0.2em] sm:text-4xl">
                  {formatSas(request.sas)}
                </span>
              </div>
              <p className="mt-2 text-center text-xs text-muted-foreground">
                The other device is showing six digits too. Deny if they differ.
              </p>
            </>
          ) : (
            <p
              className="mt-4 rounded-lg border border-border bg-muted/40 px-4 py-3 text-center text-sm text-muted-foreground"
              data-testid="approval-no-sas"
            >
              This device entered the pairing code shown on the machine. Deny
              unless you just typed it yourself.
            </p>
          )}

          <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button
              variant="outline"
              autoFocus
              disabled={answering}
              onClick={() => answer(false)}
              className="min-h-12 sm:min-w-28"
            >
              Deny
            </Button>
            <Button
              disabled={answering}
              onClick={() => answer(true)}
              className="min-h-12 sm:min-w-28"
            >
              {answering ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              ) : null}
              Approve
            </Button>
          </div>

          <p
            className="mt-3 text-center text-xs text-muted-foreground"
            role="status"
          >
            {remaining > 0
              ? `Expires in ${remaining}s. Doing nothing denies it.`
              : "Expired. Doing nothing denied it."}
          </p>
        </DialogContentRaw>
      </DialogPortal>
    </Dialog>
  );
}
