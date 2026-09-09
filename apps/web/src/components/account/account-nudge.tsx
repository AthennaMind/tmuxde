"use client";

import Link from "next/link";
import { LayoutGrid, X } from "lucide-react";
import { Button } from "@repo/ui/components/ui/button";
import { useEffect, useState } from "react";
import { isHostedBuild, useSession } from "@/lib/auth-client";
import { AccountValue } from "./account-value";
import {
  ACCOUNT_NUDGE_DISMISSED_KEY,
  readStored,
  writeStored,
} from "@/lib/storage-keys";

/**
 * The account bridge in the terminal's settings panel.
 *
 * The panel used to show "Your machines" to **everyone**, signed in or not, so
 * an anonymous pairer tapped it and was bounced to `/signin` with no
 * explanation — a wall in the one product that promises there isn't one. On a
 * phone this panel *is* the settings page (the desktop header with its
 * dashboard link is hidden below 768px), so it was also the only bridge
 * offered, which made the bad version of it the whole experience.
 *
 * Signed in: the button, unchanged. Signed out: the reason first, and
 * dismissible — a nudge you cannot silence is an advertisement.
 *
 * Renders nothing at all when `!isHostedBuild`, so a self-hosted build makes no
 * claim about an account on a broker it has never heard of, and makes no
 * network call to find out.
 */
export function AccountNudge() {
  const { data: session, isPending } = useSession();
  const [dismissed, setDismissed] = useState(true);

  useEffect(() => {
    setDismissed(readStored(ACCOUNT_NUDGE_DISMISSED_KEY) !== null);
  }, []);

  if (!isHostedBuild) return null;

  // Never guess while the session is in flight: flashing a "create an account"
  // pitch at someone who has one is the worse of the two wrong answers.
  if (isPending) return null;

  if (session?.user) {
    return (
      <section>
        <h3 className="mb-1 text-sm font-semibold">Account</h3>
        <p className="mb-3 text-xs text-muted-foreground">
          Your registered machines, security and billing.
        </p>
        <Button asChild variant="outline" className="h-11 w-full">
          <Link href="/dashboard">
            <LayoutGrid className="mr-2 h-4 w-4" aria-hidden />
            Your machines
          </Link>
        </Button>
      </section>
    );
  }

  if (dismissed) return null;

  return (
    <section>
      <div className="mb-1 flex items-start justify-between gap-2">
        <h3 className="text-sm font-semibold">Account</h3>
        <Button
          variant="ghost"
          size="sm"
          className="-mt-1 h-7 px-2 text-xs text-muted-foreground"
          onClick={() => {
            writeStored(ACCOUNT_NUDGE_DISMISSED_KEY, String(Date.now()));
            setDismissed(true);
          }}
        >
          <X className="h-3.5 w-3.5" aria-hidden />
          <span className="sr-only">Hide</span>
        </Button>
      </div>
      <p className="mb-3 text-xs text-muted-foreground">
        You do not need one — this session is already working. An account adds:
      </p>
      <AccountValue variant="compact" />
      <Button asChild variant="outline" className="mt-3 h-11 w-full">
        <Link href="/signup">Create an account</Link>
      </Button>
    </section>
  );
}
