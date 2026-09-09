import { KeyRound, LayoutList, Server, Sparkles } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { limitsFor, TRIAL_DAYS } from "@repo/config/plans";
import { cn } from "@repo/ui/lib/utils";

/**
 * The one honest answer to "why would I sign in?", rendered four ways.
 *
 * Four surfaces ask this question — `/start`, the sign-up page, the terminal's
 * settings panel and the command palette — and before this they would each have
 * answered it in their own words, which is how a product ends up promising
 * something it does not do. There is one list, and everything renders it.
 *
 * **Static by construction.** No hooks, no `useSession`, no fetch. That is what
 * makes it safe to drop inside the `(auth)` group, where a component that
 * reached for the broker would put a network call in front of anonymous
 * pairing — and "the self-hosted path stays fully functional with zero contact
 * with our servers" is an invariant, not a preference.
 *
 * ## What this may not say
 *
 * Each line below was traced to code. Three tempting claims are false and must
 * never appear here:
 *
 * - *"Sign in for more bandwidth."* Backwards. Anonymous relay traffic is
 *   unmetered; signing in is what **introduces** the monthly meter. That is
 *   why `metered` exists below rather than being quietly omitted.
 * - *"3 trusted devices."* `devicesPerServer` is in the plans table and shown
 *   on the pricing page, but nothing in the product writes a `server_devices`
 *   row, so it is not a gate and must not be promised as one.
 * - *"Pair without being at the machine."* The machine still decides. Whoever
 *   is there runs `mtmux approve` and reads back six digits. An account changes
 *   how you *find* a machine, never whether it consents.
 */

export type AccountValueItem = {
  key: string;
  icon: LucideIcon;
  title: string;
  body: string;
};

const free = limitsFor("free");

export const ACCOUNT_VALUE: AccountValueItem[] = [
  {
    key: "join",
    icon: KeyRound,
    title: "Ask to join from the browser",
    body:
      "Pick a machine from your dashboard instead of hunting for a fresh code. " +
      "The machine still decides — whoever is there runs mtmux approve, and you " +
      "read back six digits to confirm it is you.",
  },
  {
    key: "dashboard",
    icon: LayoutList,
    title: "Every machine in one list",
    body:
      "With a live dot, because each machine checks in every 30 seconds. The " +
      "same list mtmux servers prints in a terminal.",
  },
  {
    key: "machines",
    icon: Server,
    title:
      free.servers === null
        ? "As many machines as you like"
        : `More than ${free.servers === 1 ? "one machine" : `${free.servers} machines`}`,
    body:
      // Interpolated rather than typed out: invariant 7 says the thresholds
      // live in plans.ts, and the way that gets broken is a sentence that
      // *means* a threshold and then nobody updates it.
      `Free registers ${free.servers === null ? "any number" : free.servers}. ` +
      "Pro lifts that and lets you name each one something other than its hostname.",
  },
  {
    key: "trial",
    icon: Sparkles,
    title: `A ${TRIAL_DAYS}-day Pro trial, by itself`,
    body:
      "It starts the first time Free is not enough — not from a button, and " +
      "never with a card. If you never hit a limit, it never starts.",
  },
];

/**
 * The line about the meter.
 *
 * Shown where someone is deciding whether to sign in, and nowhere else. Hiding
 * a limit we are about to apply is exactly the move this codebase refuses
 * everywhere else, and saying it plainly is itself part of the pitch: it is the
 * sentence a competitor's landing page would not print.
 */
const GIB = 1024 ** 3;

export const METERED_NOTE =
  free.monthlyBytes === null
    ? "Signed-in relay traffic is not metered."
    : `Signed-in relay traffic is metered at ${Math.round(free.monthlyBytes / GIB)} GB a month. Anonymous relay is not metered at all.`;

/** What stays true whether or not anyone signs in. */
export const UNCHANGED_NOTE =
  "Pairing, the tunnel and every session work the same signed out. Sessions are read by this browser straight from each machine — mtmux's servers never see a session name.";

export function AccountValue({
  variant = "full",
  showMeter = false,
  className,
}: {
  /** `compact` drops the icons and tightens the type, for a settings panel. */
  variant?: "full" | "compact";
  /** Only on `/start` and `/signup`, where the trade is actually being made. */
  showMeter?: boolean;
  className?: string;
}) {
  const compact = variant === "compact";

  return (
    <div className={cn("space-y-3", className)}>
      <ul className={cn("space-y-3", compact && "space-y-2.5")}>
        {ACCOUNT_VALUE.map((item) => {
          const Icon = item.icon;
          return (
            <li key={item.key} className="flex gap-3">
              {!compact && (
                <Icon
                  aria-hidden
                  className="mt-0.5 h-4 w-4 shrink-0 text-primary"
                />
              )}
              <div className="min-w-0">
                <p
                  className={cn(
                    "font-medium text-foreground",
                    compact ? "text-[0.8125rem]" : "text-sm",
                  )}
                >
                  {item.title}
                </p>
                <p
                  className={cn(
                    "text-muted-foreground",
                    compact ? "text-xs leading-relaxed" : "text-sm leading-relaxed",
                  )}
                >
                  {item.body}
                </p>
              </div>
            </li>
          );
        })}
      </ul>

      {showMeter && (
        <p className="text-xs leading-relaxed text-muted-foreground">
          {METERED_NOTE}
        </p>
      )}
    </div>
  );
}
