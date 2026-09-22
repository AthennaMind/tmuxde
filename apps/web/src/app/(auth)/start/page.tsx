"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ChevronDown } from "lucide-react";
import { Button } from "@repo/ui/components/ui/button";
import { ConnectPanel } from "@/components/entry/connect-panel";
import { InstallMachine } from "@/components/entry/install-machine";
import { AccountValue, METERED_NOTE } from "@/components/account/account-value";
import { takeBounce } from "@/lib/bounce-guard";
import { servesRelay } from "@/lib/origin-mode";
import { env } from "@/env";

/**
 * The front door.
 *
 * ## Why this is a code field and not a chooser
 *
 * An earlier draft made this a three-way "how do you want to connect?" menu.
 * That is the wrong shape. Both documented routes in — the banner `mtmux start`
 * prints, and the quickstart on mtmux.com — put a pairing code in the user's hand
 * *before* they open a browser. A chooser taxes the majority path with a
 * decision they have already made, in service of two minority paths that are
 * one line of text each.
 *
 * So the code field leads and everything else is a footnote underneath it.
 *
 * ## What was here before
 *
 * Nothing. `/` sent any visitor with no token and no descriptor to `/login`,
 * which asks for the self-hosted 64-hex `AUTH_TOKEN` — a credential a hosted
 * visitor has no way to obtain. Typing the documented pairing code into it opened
 * a socket to `wss://app.mtmux.com/_relay`, a route that does not exist on that
 * origin, and hung for five seconds before blaming the relay server. The page
 * that actually takes a pairing code, `/j`, was linked from nowhere.
 */
export default function StartPage() {
  const [bounced, setBounced] = useState(false);
  /**
   * Whether a pairing broker exists for this build at all.
   *
   * Distinct from `servesRelay()` below, which asks a different question — see
   * `origin-mode.ts`. This one is build-time and decides whether the code-entry
   * path exists; that one is a runtime probe and only reorders emphasis.
   */
  const hasBroker = Boolean(env.NEXT_PUBLIC_API_URL);
  const [localOrigin, setLocalOrigin] = useState(false);
  const [showInstall, setShowInstall] = useState(false);
  const [showAccount, setShowAccount] = useState(false);

  // Read-and-clear, so a visitor who pairs and comes back is not still being
  // warned about a bounce that has since been resolved.
  useEffect(() => setBounced(takeBounce()), []);

  // Cosmetic only — it decides which of two always-present options is
  // emphasised. See `origin-mode.ts` for why this is a probe and not
  // `isHostedBuild`.
  useEffect(() => {
    let cancelled = false;
    void servesRelay().then((yes) => {
      if (!cancelled) setLocalOrigin(yes);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-6 px-4 py-10">
      {bounced && (
        <div
          className="rounded-lg border border-border bg-muted/40 p-4 text-sm"
          role="status"
        >
          <p className="text-foreground">That session is no longer usable.</p>
          <p className="mt-1 text-muted-foreground">
            Its keys are gone from this browser — some browsers clear them after
            a few weeks of not visiting. Enter a fresh code to reconnect.
          </p>
        </div>
      )}

      {/*
        The code field leads unconditionally now, and the change is invariant #4
        showing up in the UI.

        This used to branch on `hasBroker`: a build with no `NEXT_PUBLIC_API_URL`
        got an apology and a link to the token form, on the reasoning that a
        build with no broker has no pairing codes. That reasoning was true right
        up until `mtmux start` began printing six digits of its own, which are
        redeemed against the machine serving this very page and involve no
        broker at all. Leading with "there are no pairing codes" in front of
        somebody holding six of them is the worst kind of wrong — confidently,
        and about the thing they are looking at.
      */}
      <ConnectPanel variant="full" />

      <div className="space-y-3 border-t border-border pt-5 text-sm">
        <div>
          <button
            type="button"
            onClick={() => setShowInstall((v) => !v)}
            aria-expanded={showInstall}
            className="flex w-full items-center gap-1 rounded-md py-1 text-left text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ChevronDown
              className={`h-4 w-4 shrink-0 transition-transform ${showInstall ? "" : "-rotate-90"}`}
              aria-hidden
            />
            Nothing running yet?
          </button>
          {showInstall && (
            <div className="mt-3 space-y-3">
              <p className="text-muted-foreground">
                Run these on the machine you want to reach. It prints a code.
              </p>
              <InstallMachine />
            </div>
          )}
        </div>

        {/*
         * Collapsed, and second.
         *
         * The code field is the page — nine visitors in ten arrive holding a
         * code — so this answers "why would I sign in?" for the tenth without
         * taxing the rest. `hasBroker` gates it because a build with no broker
         * has no account to offer, which is invariant #4 rather than a detail.
         */}
        {hasBroker && (
          <div>
            <button
              type="button"
              onClick={() => setShowAccount((v) => !v)}
              aria-expanded={showAccount}
              className="flex w-full items-center gap-1 rounded-md py-1 text-left text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <ChevronDown
                className={`h-4 w-4 shrink-0 transition-transform ${showAccount ? "" : "-rotate-90"}`}
                aria-hidden
              />
              What does an account add?
            </button>
            {showAccount && (
              <div className="mt-3 space-y-3">
                <p className="text-muted-foreground">
                  Nothing you are doing right now needs one. Pairing, the tunnel
                  and every session work exactly the same signed out.
                </p>
                <AccountValue />
                {/* Stays in. This is the page where the trade is actually
                    being made, and hiding a meter we are about to apply is
                    the one thing that would make everything above it suspect. */}
                <p className="text-xs leading-relaxed text-muted-foreground">
                  {METERED_NOTE}
                </p>
                <Button asChild variant="outline" className="h-11 w-full">
                  <Link href="/signup">Create an account</Link>
                </Button>
              </div>
            )}
          </div>
        )}

        {/* Both of these stay visible whichever way the probe resolves; the
            origin only decides which one reads as the likelier answer. */}
        <div className="flex flex-col gap-2">
          <EntryLink
            href="/signin"
            label="Already have an account?"
            action="Sign in"
            lead={!localOrigin}
          />
          {hasBroker && (
            <EntryLink
              href="/login"
              label="Self-hosting with a token?"
              action="Use a token"
              lead={localOrigin}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function EntryLink({
  href,
  label,
  action,
  lead,
}: {
  href: string;
  label: string;
  action: string;
  lead: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      <Button
        asChild
        variant={lead ? "outline" : "ghost"}
        size="sm"
        className="h-9 shrink-0"
      >
        <Link href={href}>{action}</Link>
      </Button>
    </div>
  );
}
