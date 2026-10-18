import { Outlet } from "react-router";
import { EntryHeader } from "./entry-header";

/**
 * Chrome for the pages you reach before you are connected to anything.
 *
 * Deliberately *not* wrapped in `LockGate`. These are the pages a locked device
 * would use to sign in again, and a lock screen in front of them would be a
 * lockout — see `sealKeysIfUnlocked`, which is what actually keeps a locked
 * device from writing plaintext keys on this path.
 */
export function EntryLayout() {
  return (
    <div className="flex min-h-[100dvh] flex-col bg-background">
      <EntryHeader />
      <main className="flex flex-1 flex-col">
        <Outlet />
      </main>
    </div>
  );
}
