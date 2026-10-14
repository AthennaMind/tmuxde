import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { hydrateLockState } from "@/lib/lock-store";
import { isEnrolled, isUnlocked, subscribeLock } from "@/lib/unlocked";
import { useLockLifecycle } from "@/hooks/use-lock-lifecycle";
import { LockScreen } from "./lock-screen";

/**
 * Renders the lock screen *instead of* its children while locked.
 *
 * Unmounting rather than overlaying is the whole point: xterm keeps its
 * scrollback in JS objects hanging off the component, so a hidden terminal is a
 * readable terminal. Swapping the subtree makes it garbage.
 *
 * The gate is transparent — literally a no-op — on a device with no lock
 * enrolled, which is the default and the entire self-hosted path.
 */
export function LockGate({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  const [, force] = useState(0);

  useLockLifecycle();

  useEffect(() => subscribeLock(() => force((n) => n + 1)), []);

  useEffect(() => {
    let cancelled = false;
    void hydrateLockState().finally(() => {
      if (!cancelled) setReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Until the lock record has been read, do not render the children: a flash of
  // the shell before the lock screen appears would defeat the feature on every
  // cold load. But render *something* — this used to be `null`, which on a slow
  // IndexedDB open is indistinguishable from a page that failed to load, and it
  // stacks with the auth guard's own check to produce a blank screen twice over.
  if (!ready) {
    return (
      <div
        className="flex min-h-[100dvh] items-center justify-center bg-background"
        role="status"
        aria-live="polite"
      >
        <Loader2
          className="h-5 w-5 animate-spin text-muted-foreground"
          aria-hidden
        />
        <span className="sr-only">Checking whether this device is locked</span>
      </div>
    );
  }

  if (isEnrolled() && !isUnlocked()) {
    return <LockScreen onUnlocked={() => force((n) => n + 1)} />;
  }

  return <>{children}</>;
}
