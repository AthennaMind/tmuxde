"use client";

import { useEffect } from "react";
import Link from "next/link";
import { AlertTriangle } from "lucide-react";
import { Button } from "@repo/ui/components/ui/button";

/**
 * What a render throw on an account page looks like.
 *
 * Before this there was no boundary anywhere under `app/`, so any exception in
 * the dashboard, billing or security tree fell through to Next's built-in error
 * page — unstyled, in the wrong theme, with a stack trace in development and
 * the word "Error" and nothing else in production.
 *
 * `components/error-boundary.tsx` could not be reused: it imports the terminal
 * stores, so putting it here would pull the whole terminal client tree into
 * every account route.
 *
 * Deliberately **not** added: `(terminal)/error.tsx`. That subtree already has
 * a boundary inside its layout which knows how to tear down the WebSocket and
 * the xterm instance, and a route-level boundary would swallow the throw before
 * it ever got there.
 */
export default function AccountError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // The digest is the only handle on a production stack, and it is on the
    // error rather than anywhere we can look it up later.
    console.error("account route error", error.digest, error);
  }, [error]);

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col items-center justify-center px-4 py-16 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10">
        <AlertTriangle className="h-6 w-6 text-destructive" aria-hidden />
      </div>
      <h1 className="mt-4 text-xl font-semibold tracking-tight text-foreground">
        Something broke on this page
      </h1>
      <p className="mt-2 max-w-md text-sm text-muted-foreground">
        Nothing on your machines was touched — this page builds its list in the
        browser, so the worst that happened is that it failed to draw it.
      </p>
      <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
        <Button className="h-11" onClick={reset}>
          Try again
        </Button>
        <Button asChild variant="outline" className="h-11">
          <Link href="/dashboard">Back to your machines</Link>
        </Button>
      </div>
      {error.digest && (
        <p className="mt-6 font-mono text-xs text-muted-foreground">
          {error.digest}
        </p>
      )}
    </div>
  );
}
