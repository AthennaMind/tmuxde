"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@repo/ui/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@repo/ui/components/ui/card";
import { Check, Copy, RefreshCw, Terminal } from "lucide-react";
import { toast } from "sonner";
import { env } from "@/env";
import {
  startPairing,
  type PairingHandle,
  type PairingUpdate,
} from "@/lib/pairing-client";
import { pairedMessage, persistPairing } from "@/lib/persist-pairing";
import { CopyCommand } from "@/components/account/copy-command";
import { MIN_PAIR_CLI_VERSION } from "@repo/protocol";
import { codeGroups } from "@repo/crypto";

type State =
  | { phase: "requesting" }
  | { phase: "waiting"; code: string; expiresAt: number }
  | { phase: "verifying" }
  | { phase: "connecting" }
  /**
   * Paired, and held here for a beat before the terminal replaces the page.
   *
   * A toast fired immediately before `router.push` is a race the toast usually
   * loses: the navigation tears down the page that was going to render it. The
   * one moment worth confirming is the one that used to go unconfirmed.
   */
  | { phase: "connected"; message: string }
  | { phase: "failed"; message: string };

/** Long enough to read one line, short enough not to feel like a wait. */
const CONNECTED_DWELL_MS = 900;

function secondsLeft(expiresAt: number): number {
  // `expiresAt` already arrives on this device's clock — `startPairing` runs
  // the broker's value through `codeDeadline` — so this is plain subtraction.
  return Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));
}

export default function PairPage() {
  const router = useRouter();
  const [state, setState] = useState<State>({ phase: "requesting" });
  const [remaining, setRemaining] = useState(0);
  const [copied, setCopied] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const handleRef = useRef<PairingHandle | null>(null);

  const apiBase = env.NEXT_PUBLIC_API_URL;

  const onUpdate = useCallback(
    (update: PairingUpdate) => {
      if (update.phase === "waiting") {
        setState({
          phase: "waiting",
          code: update.code,
          expiresAt: update.expiresAt,
        });
        setRemaining(secondsLeft(update.expiresAt));
        return;
      }
      if (update.phase === "verifying") {
        setState({ phase: "verifying" });
        return;
      }
      if (update.phase === "failed") {
        setState({ phase: "failed", message: update.message });
        return;
      }

      // Paired. Race the direct candidates before falling back to the tunnel,
      // then hand off to the terminal. Shared with /j and the dashboard's
      // request-access dialog, so all three write the same record.
      setState({ phase: "connecting" });
      void (async () => {
        const { winner } = await persistPairing(update);
        setState({
          phase: "connected",
          message: pairedMessage(update.descriptor, winner),
        });
        setTimeout(() => router.push("/"), CONNECTED_DWELL_MS);
      })();
    },
    [router],
  );

  useEffect(() => {
    if (!apiBase) {
      setState({
        phase: "failed",
        message:
          "This build has no pairing service configured. Self-hosted installs use the code shown by `mtmux start` instead.",
      });
      return;
    }
    setState({ phase: "requesting" });
    const handle = startPairing({ apiBase, onUpdate });
    handleRef.current = handle;
    return () => handle.cancel();
  }, [apiBase, onUpdate, attempt]);

  // Live countdown, so an expired code visibly expires instead of just failing.
  useEffect(() => {
    if (state.phase !== "waiting") return;
    const id = setInterval(() => {
      const left = secondsLeft(state.expiresAt);
      setRemaining(left);
      if (left === 0) {
        setState({
          phase: "failed",
          message: "This code expired. Get a new one.",
        });
      }
    }, 1000);
    return () => clearInterval(id);
  }, [state]);

  const code = state.phase === "waiting" ? state.code : "";
  // Empty while there is no code; `codeGroups` throws on anything unparseable.
  const groups = code ? codeGroups(code) : [];

  async function copyCode() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Could not copy — read the digits instead.");
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center gap-5 px-4 py-10">
      <Card className="w-full">
        <CardHeader className="text-center">
          <div className="mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
            <Terminal className="h-6 w-6 text-primary" />
          </div>
          <CardTitle className="text-xl">Pair this device</CardTitle>
          <CardDescription>
            {state.phase === "waiting"
              ? "Type this code into your terminal"
              : state.phase === "connected"
                ? "Paired"
                : "Setting up a secure channel"}
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-6">
          {state.phase === "requesting" && (
            <p className="text-center text-sm text-muted-foreground">
              Getting a code…
            </p>
          )}

          {state.phase === "waiting" && (
            <>
              <button
                type="button"
                onClick={copyCode}
                aria-label={`Pairing code ${code.split("").join(" ")}, tap to copy`}
                className="mx-auto flex w-full items-center justify-center gap-1 rounded-lg border border-border bg-muted/40 py-6 transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {/* Grouped by `codeGroups` rather than sliced here, so this and
                    the CLI banner cannot disagree about where the breaks go.
                    The first group is the slot — the only part that reaches our
                    servers — and is dimmed to make that visible. */}
                {groups.map((group, g) => (
                  <span
                    key={g}
                    className={`font-mono text-4xl tabular-nums tracking-tight sm:text-5xl ${
                      g === 0 ? "text-muted-foreground" : "text-foreground"
                    }`}
                  >
                    {group}
                    {g < groups.length - 1 && (
                      <span className="px-2 opacity-30">·</span>
                    )}
                  </span>
                ))}
                <span className="ml-3 text-muted-foreground">
                  {copied ? (
                    <Check className="h-4 w-4" />
                  ) : (
                    <Copy className="h-4 w-4" />
                  )}
                </span>
              </button>

              <div className="space-y-2 rounded-lg bg-muted/40 p-4">
                <p className="text-sm text-muted-foreground">
                  On the machine running mtmux:
                </p>
                <code className="block rounded bg-background px-3 py-2 font-mono text-sm">
                  mtmux pair {code}
                </code>
                {/* The one hard break in the length change. A CLI before
                    0.7.0 parses six or eight digits and will tell the reader
                    this nine-digit code is not a pairing code — a message we
                    cannot fix retroactively, so the fix has to live here,
                    before they try it. */}
                <p className="text-xs text-muted-foreground">
                  Needs mtmux {MIN_PAIR_CLI_VERSION} or newer.
                </p>
                <CopyCommand command="mtmux upgrade" />
              </div>

              <p className="text-center text-xs text-muted-foreground">
                Expires in {remaining}s. Only the first three digits reach our
                servers; everything after is sealed end to end.
              </p>
            </>
          )}

          {state.phase === "verifying" && (
            <p className="text-center text-sm text-muted-foreground">
              Verifying the code…
            </p>
          )}

          {state.phase === "connecting" && (
            <p className="text-center text-sm text-muted-foreground">
              Connecting…
            </p>
          )}

          {state.phase === "connected" && (
            <div className="space-y-1 text-center" role="status">
              <p className="text-sm font-medium text-foreground">
                {state.message}
              </p>
              <p className="text-xs text-muted-foreground">
                Opening your terminal…
              </p>
            </div>
          )}

          {state.phase === "failed" && (
            <div className="space-y-4">
              <p className="text-center text-sm text-destructive">
                {state.message}
              </p>
              <Button
                className="w-full"
                onClick={() => setAttempt((n) => n + 1)}
              >
                <RefreshCw className="mr-2 h-4 w-4" />
                Get a new code
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* This page had no way out at all, which mattered most here: someone
          lands on it, realises their terminal is already showing a code, and
          the correct move is the opposite direction. */}
      <div className="flex items-center justify-between gap-3 text-sm">
        <span className="text-muted-foreground">
          Terminal already showing a code?
        </span>
        <Button asChild variant="outline" size="sm" className="h-9 shrink-0">
          <Link href="/start">Enter it instead</Link>
        </Button>
      </div>
    </div>
  );
}
