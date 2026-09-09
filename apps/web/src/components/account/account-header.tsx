"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@repo/ui/components/ui/button";
import { cn } from "@repo/ui/lib/utils";
import { Loader2, LogOut, Terminal } from "lucide-react";
import { toast } from "sonner";
import { isHostedBuild, signOut, useSession } from "@/lib/auth-client";

/**
 * "Machines", not "Servers".
 *
 * The product used three nouns for one thing — this nav said Servers, the
 * dashboard's h1 said "Your sessions", the section under it said "Your
 * machines" — on pages a user moves between in one click. The route stays
 * `/dashboard`: renaming it would cost a redirect and three e2e specs for
 * nothing anybody sees.
 */
const NAV = [
  { href: "/dashboard", label: "Machines" },
  { href: "/settings/security", label: "Security" },
  { href: "/settings/billing", label: "Billing" },
] as const;

/**
 * The shared chrome for every account page.
 *
 * Sticky, because on a phone the sign-out affordance disappearing off the top
 * of a long server list is how people end up stuck in the wrong account.
 */
export function AccountHeader() {
  const pathname = usePathname();
  const router = useRouter();
  const { data: session, isPending } = useSession();
  const [signingOut, setSigningOut] = useState(false);

  const signedIn = isHostedBuild && !isPending && Boolean(session);

  async function handleSignOut() {
    setSigningOut(true);
    try {
      await signOut();
      router.replace("/signin");
      router.refresh();
    } catch {
      toast.error("Could not sign out. Try again.");
    } finally {
      setSigningOut(false);
    }
  }

  return (
    /*
     * Fits a 390px phone, which it did not.
     *
     * The bar carried a wordmark, three nav links at `px-3`, an email and a
     * sign-out button inside 390px minus padding, and the overflow pushed
     * sign-out off the right edge with nothing to scroll it back. Three things
     * fix it and none of them is a hamburger — three links do not earn a menu,
     * and a menu is one more tap on every navigation to save one row of pixels.
     *
     * The wordmark's *text* hides below `sm` (the mark stays, so the home link
     * is still there and still 28px wide), nav padding tightens to `px-2`, and
     * `overflow-x-auto` is the net: if a future locale or a fourth link
     * overflows anyway, the bar scrolls rather than truncating.
     */
    <header className="sticky top-0 z-30 border-b border-border bg-background/85 pt-[env(safe-area-inset-top)] backdrop-blur supports-[backdrop-filter]:bg-background/70">
      <div className="mx-auto flex h-14 w-full max-w-3xl items-center gap-1 overflow-x-auto px-3 sm:gap-2 sm:px-4">
        <Link
          href={signedIn ? "/dashboard" : "/start"}
          aria-label="mtmux"
          className="flex shrink-0 items-center gap-2 rounded-md py-2 pr-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:pr-2"
        >
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-primary/10">
            <Terminal className="h-4 w-4 text-primary" aria-hidden />
          </span>
          <span className="hidden font-mono text-sm font-semibold tracking-tight sm:inline">
            mtmux
          </span>
        </Link>

        {signedIn && (
          <nav
            aria-label="Account"
            className="flex shrink-0 items-center gap-0.5 sm:ml-2 sm:gap-1"
          >
            {NAV.map((item) => {
              const active = pathname === item.href;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "flex h-11 items-center rounded-md px-2 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:px-3",
                    active
                      ? "text-foreground font-medium"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {item.label}
                </Link>
              );
            })}
          </nav>
        )}

        <div className="ml-auto flex shrink-0 items-center gap-1">
          {signedIn && (
            <>
              <span className="hidden max-w-[14rem] truncate text-sm text-muted-foreground sm:inline">
                {session?.user.email}
              </span>
              <Button
                variant="ghost"
                size="icon"
                className="h-11 w-11"
                onClick={handleSignOut}
                disabled={signingOut}
                aria-label="Sign out"
              >
                {signingOut ? (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                ) : (
                  <LogOut className="h-4 w-4" aria-hidden />
                )}
              </Button>
            </>
          )}
        </div>
      </div>
    </header>
  );
}
