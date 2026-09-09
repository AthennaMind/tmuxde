import Link from "next/link";
import { Compass } from "lucide-react";
import { Button } from "@repo/ui/components/ui/button";

/**
 * A missing page *inside* the account chrome.
 *
 * The root `not-found.tsx` is the same idea for everything else; this one wins
 * for routes under `(account)`, so the header, the nav and the sign-out button
 * survive a mistyped URL instead of dropping the user onto a bare page with no
 * way back into their account.
 */
export default function AccountNotFound() {
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col items-center justify-center px-4 py-16 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
        <Compass className="h-6 w-6 text-muted-foreground" aria-hidden />
      </div>
      <h1 className="mt-4 text-xl font-semibold tracking-tight text-foreground">
        There is no page here
      </h1>
      <p className="mt-2 max-w-md text-sm text-muted-foreground">
        The link may be old, or the address may have a typo in it.
      </p>
      <Button asChild className="mt-6 h-11">
        <Link href="/dashboard">Back to your machines</Link>
      </Button>
    </div>
  );
}
