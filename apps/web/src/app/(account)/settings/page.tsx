"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowLeft, LogOut } from "lucide-react";
import { Button } from "@repo/ui/components/ui/button";
import { SettingsPanel } from "@/components/settings/settings-panel";
import { LockGate } from "@/components/lock/lock-gate";
import { disconnectDevice } from "@/lib/sign-out";

/**
 * Device settings — theme, terminal, toolbar, the device lock.
 *
 * ## Why it moved into `(account)`
 *
 * It used to be a top-level route with its own full-screen chrome, so
 * navigating from `/settings` to `/settings/security` swapped the entire page
 * shell: a bespoke bar with a back arrow became the account header, and the two
 * pages under one URL prefix looked like two different products. Under this
 * layout they share chrome, and "Settings" is reachable from the security page
 * as a card rather than as a fourth item in a nav that has to fit on a phone.
 *
 * ## Why the gate is here and not on the layout
 *
 * `LockGate` stays wrapped around this page specifically. Hoisting it to
 * `(account)/layout.tsx` would also gate `signin`, `signup` and the password
 * reset — which is a lockout generator: forget the PIN, and the route that
 * could get you back into the account is behind the PIN.
 *
 * Moving the page into `(terminal)` instead would have picked up that layout's
 * gate for free, and also its auth guard — which would destroy the enrolment
 * entry point, since setting a PIN is something you do on a device that has no
 * session yet.
 */
export default function SettingsPage() {
  return (
    <LockGate>
      <SettingsPageInner />
    </LockGate>
  );
}

function SettingsPageInner() {
  const [leaving, setLeaving] = useState(false);

  /**
   * "Logout" used to clear `TOKEN_KEY` and push `/login`, which did nothing at
   * all for a device attached through a hosted pairing — the entry page found
   * the descriptor still in IndexedDB and sent you straight back. See
   * `disconnectDevice` for what actually has to be dropped.
   *
   * The label is **Disconnect** because that is the true scope: this device
   * lets go of this machine. Nothing on the machine stops, and nothing else on
   * this device is touched. "Erase everything here" is a separate, louder
   * action and it already exists in the device-lock settings below.
   */
  async function handleDisconnect() {
    setLeaving(true);
    try {
      await disconnectDevice();
    } catch {
      // `disconnectDevice` ends in a full navigation; if it threw before that,
      // re-enable the button rather than stranding the page mid-sign-out.
      setLeaving(false);
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col px-4 py-6 sm:py-8">
      <header className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">
            Settings
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            This device: how the terminal looks, what the toolbar does, and the
            lock that guards it. Nothing here leaves the browser.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {/* A link and not `router.back()`. This page is reached from the
              terminal's toolbar, and history may hold a full document load —
              the machine switcher and every session open do one — so "back"
              is not reliably the terminal. */}
          <Button asChild variant="ghost" className="h-11">
            <Link href="/">
              <ArrowLeft className="h-4 w-4" aria-hidden />
              Terminal
            </Link>
          </Button>
          <Button
            variant="outline"
            className="h-11 text-destructive"
            onClick={() => void handleDisconnect()}
            disabled={leaving}
          >
            <LogOut className="h-4 w-4" aria-hidden />
            {leaving ? "Disconnecting…" : "Disconnect"}
          </Button>
        </div>
      </header>
      <SettingsPanel className="flex-1 rounded-lg border border-border" />
    </div>
  );
}
