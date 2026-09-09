import Link from "next/link";
import { Compass } from "lucide-react";
import { Button } from "@repo/ui/components/ui/button";

/**
 * The app's 404, for anything not inside `(account)`.
 *
 * There was none, so a mistyped path rendered Next's built-in page: a bare
 * white document with `404` and `This page could not be found`, in the wrong
 * theme, with no route back into the app. On a PWA installed to a home screen
 * that is a dead end with no address bar to correct.
 *
 * It links to `/start` rather than `/dashboard`, because this boundary also
 * covers self-hosted builds where there is no account and `/dashboard` would be
 * a second dead end.
 */
export default function NotFound() {
  return (
    <div className="flex min-h-[100dvh] flex-col items-center justify-center bg-background px-4 py-16 text-center">
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
        <Link href="/start">Go to mtmux</Link>
      </Button>
    </div>
  );
}
