"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@repo/ui/components/ui/button";
import { Input } from "@repo/ui/components/ui/input";
import { Label } from "@repo/ui/components/ui/label";
import { normalizeLocalCode } from "@repo/crypto";
import { redeemLocalPairingCode } from "@/lib/local-pairing";
import { TOKEN_KEY, writeStored } from "@/lib/storage-keys";

type State =
  | { phase: "idle" }
  | { phase: "approving" }
  | { phase: "connected" }
  | { phase: "failed"; message: string };

export function ConnectPanel({
  variant = "full",
}: {
  variant?: "full" | "compact";
}) {
  const router = useRouter();
  const [state, setState] = useState<State>({ phase: "idle" });
  const [code, setCode] = useState("");
  const requestRef = useRef<AbortController | null>(null);
  const redirectRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const join = useCallback(
    async (digits: string) => {
      requestRef.current?.abort();
      const request = new AbortController();
      requestRef.current = request;
      setState({ phase: "approving" });
      try {
        const { token } = await redeemLocalPairingCode(digits, request.signal);
        if (request.signal.aborted) return;
        writeStored(TOKEN_KEY, token);
        setState({ phase: "connected" });
        redirectRef.current = setTimeout(() => router.push("/"), 900);
      } catch (error) {
        if (!request.signal.aborted) {
          setState({ phase: "failed", message: (error as Error).message });
        }
      }
    },
    [router],
  );

  useEffect(() => {
    const fragment = window.location.hash.slice(1);
    if (fragment) {
      window.history.replaceState(
        null,
        "",
        window.location.pathname + window.location.search,
      );
      let raw = fragment;
      try {
        raw = decodeURIComponent(fragment);
      } catch {
        /* Reject malformed input below. */
      }
      const digits = normalizeLocalCode(raw);
      if (digits) {
        // Fill the field without spending a one-use code during an effect replay.
        setCode(digits);
      } else {
        setState({
          phase: "failed",
          message: "Enter the six-digit code from your local machine.",
        });
      }
    }
    return () => {
      requestRef.current?.abort();
      if (redirectRef.current) clearTimeout(redirectRef.current);
    };
  }, []);

  const busy = state.phase === "approving" || state.phase === "connected";

  return (
    <div className="space-y-4">
      {variant === "full" && (
        <div className="space-y-1 text-center">
          <h1 className="text-xl font-semibold tracking-tight">
            Connect to your terminal
          </h1>
          <p className="text-sm text-muted-foreground">
            Enter the six-digit code shown on your machine
          </p>
        </div>
      )}
      {state.phase === "approving" && (
        <div className="space-y-1 text-center" role="status">
          <p className="text-sm font-medium">
            Waiting for approval on the machine
          </p>
          <p className="text-xs text-muted-foreground">
            Approve this device in your terminal.
          </p>
        </div>
      )}
      {state.phase === "connected" && (
        <p className="text-center text-sm" role="status">
          Approved. Opening your terminal...
        </p>
      )}
      {state.phase === "failed" && (
        <p className="text-center text-sm text-destructive" role="alert">
          {state.message}
        </p>
      )}
      {!busy && (
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            const digits = normalizeLocalCode(code);
            if (!digits) {
              setState({
                phase: "failed",
                message: "Enter the six-digit code from your local machine.",
              });
              return;
            }
            void join(digits);
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="code">Pairing code</Label>
            <Input
              id="code"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="492 716"
              maxLength={16}
              autoFocus
              className="h-14 text-center font-mono text-2xl tracking-[0.3em] tabular-nums"
            />
          </div>
          <Button className="h-11 w-full" type="submit">
            Connect
          </Button>
          <p className="text-center text-xs text-muted-foreground">
            Code goes directly to your local machine.
          </p>
        </form>
      )}
    </div>
  );
}
