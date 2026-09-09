"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { Check, Download, Share } from "lucide-react";
import { Button } from "@repo/ui/components/ui/button";
import { Separator } from "@repo/ui/components/ui/separator";
import {
  getInstallSnapshot,
  getServerInstallSnapshot,
  installAvailability,
  isIosDevice,
  promptInstall,
  subscribeInstall,
  type InstallAvailability,
} from "@/lib/install-prompt";
import { useAlertStore } from "@/stores/alert-store";

/**
 * Observations that only exist in a browser, resolved after mount.
 *
 * They cannot be read during render without breaking hydration — the server
 * has no display mode and no user agent — so the section renders its
 * "unavailable" (i.e. nothing) branch on the first paint and settles a tick
 * later.
 */
function useEnvironment() {
  const [env, setEnv] = useState({
    standalone: false,
    iosDevice: false,
    secureContext: true,
    resolved: false,
  });

  useEffect(() => {
    const standaloneQuery = window.matchMedia("(display-mode: standalone)");
    const read = () =>
      setEnv({
        standalone:
          standaloneQuery.matches ||
          window.matchMedia("(display-mode: minimal-ui)").matches ||
          // iOS predates the display-mode media query and still needs this.
          (navigator as Navigator & { standalone?: boolean }).standalone ===
            true,
        iosDevice: isIosDevice(navigator),
        secureContext: window.isSecureContext,
        resolved: true,
      });

    read();
    standaloneQuery.addEventListener("change", read);
    return () => standaloneQuery.removeEventListener("change", read);
  }, []);

  return env;
}

export function useInstallAvailability(): InstallAvailability | null {
  const { standalone, iosDevice, secureContext, resolved } = useEnvironment();
  const snapshot = useSyncExternalStore(
    subscribeInstall,
    getInstallSnapshot,
    getServerInstallSnapshot,
  );
  if (!resolved) return null;
  if (snapshot.installed) return "installed";
  return installAvailability({
    standalone,
    hasPrompt: snapshot.hasPrompt,
    iosDevice,
    secureContext,
  });
}

/**
 * How to install, said out loud.
 *
 * Nothing in the app used to mention that it was installable. On Android that
 * cost users a home-screen icon they would have taken; on iOS, where there is
 * no prompt API at all, telling them is the *only* way it can ever happen.
 * Installed is by far the better way to use a terminal on a phone — full
 * height, no browser chrome eating a fifth of the screen, and no address bar
 * that reappears on every scroll.
 */
export function InstallAppSection() {
  const availability = useInstallAvailability();

  if (availability === null || availability === "unavailable") return null;

  return (
    <>
      <Separator />
      <section>
        <h3 className="mb-1 text-sm font-semibold">Install</h3>
        {availability === "installed" && (
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <Check className="h-3.5 w-3.5 shrink-0" aria-hidden />
            Running as an installed app.
          </p>
        )}

        {availability === "prompt" && (
          <>
            <p className="mb-3 text-xs text-muted-foreground">
              Add mtmux to your home screen for a full-height terminal with no
              browser chrome.
            </p>
            <Button
              variant="outline"
              className="h-11 w-full"
              onClick={async () => {
                const outcome = await promptInstall();
                if (outcome === "unavailable") {
                  useAlertStore
                    .getState()
                    .push(
                      "info",
                      "Your browser did not offer an install prompt",
                    );
                }
              }}
            >
              <Download className="mr-2 h-4 w-4" aria-hidden />
              Install mtmux
            </Button>
          </>
        )}

        {availability === "manual" && (
          <p className="flex items-start gap-2 text-xs text-muted-foreground">
            <Share className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
            <span>
              Tap <strong className="font-medium text-foreground">Share</strong>
              , then{" "}
              <strong className="font-medium text-foreground">
                Add to Home Screen
              </strong>{" "}
              — you get a full-height terminal with no browser chrome.
            </span>
          </p>
        )}

        {availability === "insecure" && (
          <p className="text-xs text-muted-foreground">
            Installing needs a secure origin. Open the invite link from{" "}
            <code className="font-mono text-[11px]">mtmux start</code> instead
            of the plain LAN address, and this page can be installed.
          </p>
        )}
      </section>
    </>
  );
}
