"use client";

import { useEffect } from "react";
import {
  captureInstallPrompt,
  markInstalled,
  type BeforeInstallPromptEvent,
} from "@/lib/install-prompt";

/**
 * Arms everything install-related, as early as the app renders anything.
 *
 * It lives in the root layout rather than in `(terminal)/layout.tsx`, where the
 * registration used to be, for two reasons. `beforeinstallprompt` fires once
 * and very early — a listener attached after the terminal route group has
 * mounted routinely misses it — and the invite URL the CLI prints lands on
 * `/j#code`, not on the terminal, so users following the documented path never
 * reached the old registration at all.
 *
 * Renders nothing.
 */
export function PwaProvider() {
  useEffect(() => {
    /*
     * `isSecureContext` is the gate, not a nicety.
     *
     * `mtmux start` serves the app over plain http on the LAN
     * (`apps/cli/src/serve.ts`), where `serviceWorker.register` rejects by
     * spec. The old call site swallowed that rejection into an empty catch, so
     * the self-hosted path had a permanently failing registration and no
     * signal anywhere. Not attempting it is the honest version — and iOS "Add
     * to Home Screen" still works there, which is why the manifest stays.
     */
    if (!window.isSecureContext || !("serviceWorker" in navigator)) return;

    let registration: ServiceWorkerRegistration | null = null;

    navigator.serviceWorker
      // Without this the browser may serve `sw.js` itself from the HTTP cache,
      // so a fixed worker can take up to its max-age to reach anyone.
      .register("/sw.js", { updateViaCache: "none" })
      .then((reg) => {
        registration = reg;
      })
      .catch((error: unknown) => {
        console.warn("[mtmux] service worker registration failed:", error);
      });

    // Browsers only check for a new worker on navigation, and this is a
    // single-page app someone leaves open for days. Checking when the tab comes
    // back is the cheapest way to make a deploy actually land.
    const onVisible = () => {
      if (document.visibilityState === "visible") void registration?.update();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);

  useEffect(() => {
    const onBeforeInstall = (event: Event) => {
      // Chromium shows its own mini-infobar unless the event is cancelled, and
      // an uncancelled event cannot be replayed later from our own UI.
      event.preventDefault();
      captureInstallPrompt(event as BeforeInstallPromptEvent);
    };
    const onInstalled = () => markInstalled();

    window.addEventListener("beforeinstallprompt", onBeforeInstall);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstall);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  return null;
}
