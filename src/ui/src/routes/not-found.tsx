import { Link } from "react-router";
import { Compass } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * The app's 404, the catch all route.
 *
 * Without it a mistyped path is a dead end. On a PWA installed to a home
 * screen there is no address bar to correct it. The link goes to `/login`,
 * the one entry page in a standalone stack.
 */
export function NotFound() {
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
        <Link to="/login">Go to tmuxde</Link>
      </Button>
    </div>
  );
}
