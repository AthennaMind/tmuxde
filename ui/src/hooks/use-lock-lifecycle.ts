import { useEffect, useState } from "react";
import {
  ceremonyInProgress,
  listenForCrossTabLock,
  lockNow,
} from "@/lib/lock-controller";
import { readLockRecord, type LockRecord } from "@/lib/lock-store";
import { isEnrolled, isUnlocked, subscribeLock } from "@/lib/unlocked";

/**
 * The four things that lock a device, plus the one that ships without a lock.
 *
 * 1. **Cold load** — structural. The master key is a module variable; a reload
 *    loses it. No code here does that, which is the point.
 * 2. **Idle timeout** — default 15 minutes.
 * 3. **Explicit** — Ctrl/Cmd+Shift+L.
 * 4. **Backgrounding** — *default off on mobile*. iOS fires `visibilitychange`
 *    for the app switcher, the share sheet and the Face ID prompt itself, so it
 *    needs a grace period and hard suppression during a WebAuthn ceremony
 *    before it is usable at all.
 *
 * And separately: **blur the screen while hidden, on by default, lock or no
 * lock.** It is thirty lines and it keeps your shell out of the OS
 * app-switcher screenshot — the one place a terminal leaks to someone standing
 * behind you without any attacker involved.
 */

const ACTIVITY_EVENTS = [
  "pointerdown",
  "keydown",
  "wheel",
  "touchstart",
] as const;

/** How long after backgrounding to actually lock, so an app-switch flick is free. */
const BACKGROUND_GRACE_MS = 8_000;

export function useLockLifecycle(): void {
  const [settings, setSettings] = useState<LockRecord | null>(null);
  const [, force] = useState(0);

  useEffect(() => subscribeLock(() => force((n) => n + 1)), []);

  useEffect(() => {
    let cancelled = false;
    void readLockRecord().then((record) => {
      if (!cancelled) setSettings(record);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Idle timeout.
  useEffect(() => {
    const minutes = settings?.idleMinutes ?? 15;
    if (!isEnrolled() || !isUnlocked() || minutes <= 0) return;

    let timer: ReturnType<typeof setTimeout>;
    const reset = () => {
      clearTimeout(timer);
      timer = setTimeout(() => lockNow("idle"), minutes * 60_000);
    };
    reset();
    for (const event of ACTIVITY_EVENTS) {
      window.addEventListener(event, reset, { passive: true });
    }
    return () => {
      clearTimeout(timer);
      for (const event of ACTIVITY_EVENTS) {
        window.removeEventListener(event, reset);
      }
    };
  }, [settings]);

  // Explicit lock.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (
        (e.ctrlKey || e.metaKey) &&
        e.shiftKey &&
        e.key.toLowerCase() === "l"
      ) {
        e.preventDefault();
        lockNow("manual");
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // Lock on background, and blur while hidden.
  useEffect(() => {
    const lockOnBackground = settings?.lockOnBackground === true;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const onVisibility = () => {
      const hidden = document.visibilityState === "hidden";
      document.documentElement.classList.toggle("tmuxde-hidden", hidden);

      if (!lockOnBackground) return;
      if (!hidden) {
        if (timer) clearTimeout(timer);
        timer = null;
        return;
      }
      // Suppressed outright during a WebAuthn ceremony — the system prompt
      // hides the page, so this would fire on the very gesture meant to unlock.
      if (ceremonyInProgress()) return;
      timer = setTimeout(() => lockNow("background"), BACKGROUND_GRACE_MS);
    };

    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
      document.documentElement.classList.remove("tmuxde-hidden");
    };
  }, [settings]);

  useEffect(() => listenForCrossTabLock(), []);
}
