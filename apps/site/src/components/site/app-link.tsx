import { ArrowUpRight } from "lucide-react";

import { siteConfig } from "@/config/site";
import { cn } from "@/lib/utils";

/**
 * The one link from mtmux.com to the product.
 *
 * Until this existed there was no path at all: not in the header, the footer or
 * any page. You could only reach the app by typing the hostname yourself, which
 * made every account feature on /pricing unreachable from the site selling it.
 *
 * The label is **"open app"**, not "sign in", for three reasons. It is true for
 * everyone — an anonymous pairer lands on `/start` and gets the code field, a
 * paired browser lands straight in its terminal. A naked "Sign in" top-right of
 * a CLI tool's site reads to this audience as *there is a wall coming*, on a
 * site that promises "no account needed" five times. And sign-in is still one
 * tap away on the page where someone is actually thinking about accounts.
 *
 * A server component, unlike `NavLink`: there is no active state to track, since
 * the destination is a different origin. External-link convention matches the
 * rest of the site — a raw anchor with `rel="noreferrer noopener"`, never the
 * locale-aware `Link`.
 */
export function AppLink({
  label,
  className,
}: {
  label: string;
  className?: string;
}) {
  return (
    <a
      href={siteConfig.appUrl}
      rel="noreferrer noopener"
      className={cn(
        // One notch quieter than NavLink, so CopyInstall stays the only
        // bordered control in the header and keeps the primary action.
        "inline-flex items-center gap-1 rounded-md px-2.5 py-2 text-[1rem] text-text-muted transition-colors hover:bg-surface-panel hover:text-text-strong",
        className,
      )}
    >
      {label}
      <ArrowUpRight aria-hidden="true" className="size-3.5 text-text-faint" />
    </a>
  );
}
