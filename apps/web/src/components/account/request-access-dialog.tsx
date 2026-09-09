"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { formatSas } from "@repo/crypto";
import { REQUEST_TTL_MS } from "@repo/protocol";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@repo/ui/components/ui/dialog";
import { Button } from "@repo/ui/components/ui/button";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { env } from "@/env";
import {
  requestAccess,
  type AccessRequestUpdate,
  type PairingHandle,
} from "@/lib/pairing-client";
import { pairedMessage, persistPairing } from "@/lib/persist-pairing";
import { deviceLabel } from "@/lib/device-label";
import { semverGte } from "@repo/protocol";
import { CopyCommand } from "./copy-command";
import type { RegisteredServer } from "./registered-server";

/**
 * "Pair this device", made to actually pair.
 *
 * The button existed and did a local IndexedDB lookup, failed, and told you to
 * go and use the other computer. `requestAccess()` — fully wired through
 * crypto, protocol, broker and CLI — had zero callers. This is the caller.
 *
 * ## Why there is no "yes, they match" button
 *
 * The six digits are a *verification* the human at the machine performs, not a
 * decision this browser makes. By the time `confirm` renders, `pair:reveal` has
 * already gone — it has to, because the SAS is derived from both public keys.
 * A button here would imply the browser is still holding something back, and
 * it is not. What the user does with the digits is read them aloud; the machine
 * is where the y/N lives.
 *
 * ## Mounted once, not per row
 *
 * The broker enforces one live request per device. N dialogs would be N ways to
 * race each other into a 409, so the dashboard page keeps a single
 * `useState<RegisteredServer | null>` and this component reads it.
 */

type State =
  | { phase: "asking" }
  | { phase: "confirm"; sas: string }
  | { phase: "connecting" }
  | { phase: "failed"; message: string; reason?: string };

/**
 * The first CLI that answers `mtmux approve`.
 *
 * Gating the *copy* on a self-reported version is fine; gating a security
 * decision on one would not be. `semverGte` returns null for anything it cannot
 * parse, and an unknown version reads as "show it" here — telling someone about
 * a command their CLI might not have is recoverable, and the alternative is
 * hiding the only way out from a machine whose version string is odd.
 */
const APPROVE_SINCE = "0.5.0";

function hasApprove(cliVersion: string | null): boolean {
  return semverGte(cliVersion, APPROVE_SINCE) !== false;
}

export function RequestAccessDialog({
  server,
  onOpenChange,
  onPaired,
}: {
  /** Null when closed. Opening is "set this to a machine". */
  server: RegisteredServer | null;
  onOpenChange: (open: boolean) => void;
  onPaired: () => void;
}) {
  const [state, setState] = useState<State>({ phase: "asking" });
  const [remaining, setRemaining] = useState(REQUEST_TTL_MS / 1000);
  const handleRef = useRef<PairingHandle | null>(null);

  const apiBase = env.NEXT_PUBLIC_API_URL;
  const serverId = server?.id ?? null;

  useEffect(() => {
    if (!serverId || !apiBase) return;
    setState({ phase: "asking" });

    const onUpdate = (update: AccessRequestUpdate) => {
      if (update.phase === "confirm") {
        setState({ phase: "confirm", sas: update.sas });
        return;
      }
      if (update.phase === "failed") {
        setState({
          phase: "failed",
          message: update.message,
          reason: update.reason,
        });
        return;
      }
      if (update.phase === "asking") return;

      setState({ phase: "connecting" });
      void (async () => {
        try {
          const { winner } = await persistPairing(update);
          toast.success(pairedMessage(update.descriptor, winner));
          onPaired();
          onOpenChange(false);
        } catch (err) {
          // The one that actually happens: a locked device, where
          // `saveSessionKeys` refuses to write plaintext keys.
          setState({
            phase: "failed",
            message:
              err instanceof Error
                ? err.message
                : "Could not save this pairing.",
          });
        }
      })();
    };

    handleRef.current = requestAccess({
      apiBase,
      serverId,
      deviceLabel: deviceLabel(),
      onUpdate,
    });

    return () => handleRef.current?.cancel();
    // `onPaired`/`onOpenChange` are stable callers; re-running on their
    // identity would restart a live request mid-handshake.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverId, apiBase]);

  /**
   * A visible time budget.
   *
   * The request expires after `REQUEST_TTL_MS` whatever anyone does, and the
   * dialog showed no sign of it — so "waiting for someone to answer" looked
   * identical at second 2 and second 118, and someone who walked away had no
   * way to know whether it was still worth walking back.
   */
  useEffect(() => {
    if (state.phase !== "asking" && state.phase !== "confirm") return;
    const deadline = Date.now() + remaining * 1000;
    const id = setInterval(() => {
      setRemaining(Math.max(0, Math.ceil((deadline - Date.now()) / 1000)));
    }, 1000);
    return () => clearInterval(id);
    // Restarted only when the phase changes. `remaining` is read once as a
    // seed; depending on it would reset the deadline on every tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.phase]);

  const noTty = state.phase === "failed" && state.reason === "no-tty";
  // A request nobody answered and one somebody actively said no to need
  // different words and different next steps — the first is "try again", and
  // the second is emphatically not.
  const timedOut = state.phase === "failed" && state.reason === "timeout";
  const refused = state.phase === "failed" && state.reason === "refused";

  return (
    <Dialog open={server !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {state.phase === "confirm"
              ? "Check these digits match"
              : `Pair with ${server?.name ?? "this machine"}`}
          </DialogTitle>
          <DialogDescription>
            {state.phase === "asking" &&
              "Asking that machine to let this browser in. Someone at it has to approve."}
            {state.phase === "confirm" &&
              "The same six digits are on that machine's screen. Approve there only if they match."}
            {state.phase === "connecting" &&
              "Approved. Setting up the session."}
            {state.phase === "failed" && "That did not go through."}
          </DialogDescription>
        </DialogHeader>

        {state.phase === "asking" && (
          <div
            className="flex items-center gap-3 py-6 text-sm text-muted-foreground"
            role="status"
          >
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            Waiting for someone to answer… {formatRemaining(remaining)}
          </div>
        )}

        {state.phase === "confirm" && (
          <div className="space-y-4">
            <div
              className="flex items-center justify-center gap-1 rounded-lg border border-border bg-muted/40 py-6"
              aria-label={`Verification digits ${state.sas.split("").join(" ")}`}
            >
              {formatSas(state.sas)
                .split("")
                .map((ch, i) =>
                  ch === " " ? (
                    <span key={i} className="px-2 opacity-30">
                      ·
                    </span>
                  ) : (
                    <span
                      key={i}
                      className="font-mono text-4xl tabular-nums tracking-tight sm:text-5xl"
                    >
                      {ch}
                    </span>
                  ),
                )}
            </div>
            <p className="text-center text-xs text-muted-foreground">
              If they differ, refuse it on the machine. Nothing usable has been
              exchanged.
            </p>
            <p className="text-center text-xs text-muted-foreground">
              Expires in {formatRemaining(remaining)}.
            </p>
          </div>
        )}

        {state.phase === "connecting" && (
          <div
            className="flex items-center gap-3 py-6 text-sm text-muted-foreground"
            role="status"
          >
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            Connecting…
          </div>
        )}

        {state.phase === "failed" && (
          <div className="space-y-4">
            <p className="text-sm text-destructive" role="alert">
              {state.message}
            </p>

            {/*
              The no-tty case needs a real way out, and used to name a command
              that did not exist. The primary recovery is the code path, which
              works on every CLI version in the field with no new protocol: the
              browser shows digits, the user runs `mtmux pair <code>` over SSH.
            */}
            {noTty && (
              <div className="space-y-3 rounded-lg border border-border bg-muted/40 p-4">
                <p className="text-sm text-muted-foreground">
                  Nobody is sitting at that machine. If you can reach it over
                  SSH, pair with a code instead — it works on any version.
                </p>
                <Button asChild className="h-11 w-full">
                  <Link href="/pair">Pair with a code instead</Link>
                </Button>
                {hasApprove(server?.cliVersion ?? null) && (
                  <div className="space-y-2 pt-1">
                    <p className="text-xs text-muted-foreground">
                      Or open an approval window on the machine, then try again:
                    </p>
                    <CopyCommand command="mtmux approve" />
                  </div>
                )}
              </div>
            )}

            {/*
              A timeout is not a refusal, and a refusal is not a timeout. Both
              used to end at a Close button with nothing to do next.
            */}
            {timedOut && (
              <div className="space-y-3 rounded-lg border border-border bg-muted/40 p-4">
                <p className="text-sm text-muted-foreground">
                  Nobody answered in time. The request is gone — nothing was
                  approved and nothing was shared.
                </p>
                <Button
                  className="h-11 w-full"
                  onClick={() => setState({ phase: "asking" })}
                >
                  Ask again
                </Button>
                {hasApprove(server?.cliVersion ?? null) && (
                  <div className="space-y-2 pt-1">
                    <p className="text-xs text-muted-foreground">
                      To answer it without walking over, open a window on the
                      machine first:
                    </p>
                    <CopyCommand command="mtmux approve" />
                  </div>
                )}
              </div>
            )}

            {refused && (
              <div className="space-y-3 rounded-lg border border-border bg-muted/40 p-4">
                <p className="text-sm text-muted-foreground">
                  Someone at that machine said no. If that was not you, do not
                  ask again — find out who is at it.
                </p>
                <Button asChild variant="outline" className="h-11 w-full">
                  <Link href="/pair">Pair with a code instead</Link>
                </Button>
              </div>
            )}

            <Button
              variant="outline"
              className="h-11 w-full"
              onClick={() => onOpenChange(false)}
            >
              Close
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** "1:58", or "12s" once it is short enough to read as a number. */
function formatRemaining(seconds: number): string {
  if (seconds <= 0) return "0s";
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
