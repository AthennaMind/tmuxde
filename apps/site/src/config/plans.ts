/**
 * Plan limits and prices, mirrored for the marketing site.
 *
 * **The source of truth is `packages/config/src/plans.ts`** (`@repo/config/plans`),
 * which the broker actually enforces. This file exists only because `@app/site`
 * does not depend on `@repo/config` — the marketing site is deployed on its own
 * and adding a workspace dependency for four numbers is not worth the coupling.
 *
 * If the two ever disagree, `packages/config/src/plans.ts` wins, and this file
 * is the bug. Anything shown on /pricing must be traceable to a value here.
 *
 * The authoritative prices live in Dodo Payments; these render the page without
 * a network call. The checkout a customer actually sees is Dodo's.
 */

export type PlanId = "free" | "pro";

export type Plan = {
  /** Registered servers the account may keep. `null` is unlimited. */
  servers: number | null;
  /** Trusted browsers per server. `null` is unlimited. */
  devicesPerServer: number | null;
  /** Relayed traffic per calendar month, in gibibytes. */
  monthlyGib: number;
  /** Rename a server to something other than its hostname. */
  namedServers: boolean;
};

export const PLANS: Record<PlanId, Plan> = {
  free: {
    servers: 1,
    devicesPerServer: 3,
    monthlyGib: 5,
    namedServers: false,
  },
  pro: {
    servers: null,
    devicesPerServer: null,
    monthlyGib: 200,
    namedServers: true,
  },
};

/**
 * Length of the free Pro trial, in days.
 *
 * Mirrors `TRIAL_DAYS` in `packages/config/src/plans.ts`, which is what
 * `withTrial()` actually enforces. The trial is not a button: it begins by
 * itself the first time a Free account is refused something Pro would allow,
 * and it never asks for a card. Copy has to describe it that way.
 */
export const TRIAL_DAYS = 7;

export const PRICING = {
  pro: {
    monthlyUsd: 10,
    yearlyUsd: 100,
  },
} as const;
