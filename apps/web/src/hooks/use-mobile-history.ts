"use client";

import { useEffect, useRef } from "react";
import type { MobileTab } from "@/components/mobile/mobile-nav";
import { useUiStore } from "@/stores/ui-store";

/** Guards `popstate`, whose state is whatever any page ever pushed. */
const TABS: MobileTab[] = ["terminal", "sessions", "files", "settings"];

/**
 * Make the phone's Back button switch tabs instead of leaving the app.
 *
 * Two things were wrong with the obvious version. It pushed an entry on *every*
 * `mobileTab` change including the first render, so the history stack grew
 * without bound and Back had to be pressed once per tab the user had ever
 * visited before it did anything visible. And when it ran out of entries it
 * *invented* a new destination — terminal → sessions — so Back could never
 * leave the terminal at all, which is not the browser's contract and is a
 * genuinely trapping experience on a page someone arrived at from a link.
 *
 * Now: one entry per deliberate tab change, none on mount, and once the stack
 * we pushed is spent, Back means Back.
 */
export function useMobileHistory() {
  const mobileTab = useUiStore((s) => s.mobileTab);
  const setMobileTab = useUiStore((s) => s.setMobileTab);

  /**
   * The tab the last history entry describes.
   *
   * Undefined until the first push, which is how "we have not pushed anything
   * yet" is told apart from "we are already on this tab" — the mount case, and
   * the `popstate` case, both of which must not push.
   */
  const pushedTab = useRef<string | null>(null);

  useEffect(() => {
    if (pushedTab.current === mobileTab) return;
    // Nothing to come back *to* on the very first render, and pushing there is
    // what made Back a no-op the first time it was pressed.
    if (pushedTab.current !== null) {
      window.history.pushState({ mobileTab }, "");
    }
    pushedTab.current = mobileTab;
  }, [mobileTab]);

  useEffect(() => {
    const handlePopState = (e: PopStateEvent) => {
      const state = e.state as { mobileTab?: string } | null;
      const tab = state?.mobileTab;
      // An entry that is not ours. Let the browser do what it was going to do
      // rather than manufacturing a tab change to swallow it.
      if (!tab || !TABS.includes(tab as MobileTab)) return;
      // Set the ref first: this is a tab change we are *following*, not one to
      // record, and pushing for it would refill the stack we are unwinding.
      pushedTab.current = tab;
      setMobileTab(tab as MobileTab);
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [setMobileTab]);
}
