import type { Metadata } from "next";
import { LockGate } from "@/components/lock/lock-gate";
import { RequireSession } from "@/components/account/require-session";
import { SecurityPanel } from "./security-panel";

export const metadata: Metadata = {
  title: "Security · mtmux",
  description: "Passkeys and connected accounts for your mtmux account.",
};

/**
 * Behind the device lock as well as the session.
 *
 * A locked device could walk straight here and read the account email, every
 * passkey's name and creation date, and which social accounts are connected —
 * then remove any of them. The lock exists so that a phone someone else is
 * holding shows nothing; a page that enumerates the credentials guarding the
 * account is the last one that should have been outside it.
 *
 * The gate is per page rather than on `(account)/layout.tsx` because that
 * layout also holds `signin`, `signup` and the password reset, and gating those
 * behind a forgotten PIN is a lockout generator.
 */
export default function SecurityPage() {
  return (
    <LockGate>
      <SecurityPageInner />
    </LockGate>
  );
}

function SecurityPageInner() {
  return (
    <RequireSession>
      <div className="mx-auto w-full max-w-3xl px-4 py-6 sm:py-8">
        <header className="mb-5">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">
            Security
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            How you sign in to mtmux.
          </p>
        </header>
        <SecurityPanel />
      </div>
    </RequireSession>
  );
}
