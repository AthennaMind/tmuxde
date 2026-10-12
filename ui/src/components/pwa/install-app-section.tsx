import { useEffect, useState, useSyncExternalStore } from "react";
import { Check, Download, Share } from "lucide-react";
import { Button } from "@repo/ui/components/ui/button";
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
import { SettingsRow, SettingsSection } from "@/components/settings/settings-rows";

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
    <SettingsSection title="Install">
      {availability === "installed" && (
        <SettingsRow
          label="Installed"
          hint="tmuxde is running as an installed app."
          textLabel
        >
          {() => <Check className="h-4 w-4 text-primary" aria-hidden />}
        </SettingsRow>
      )}

      {availability === "prompt" && (
        <SettingsRow
          label="Install as an app"
          hint="Full height, in its own window, with no browser chrome."
          textLabel
        >
          {() => (
            <Button
              variant="outline"
              size="sm"
              className="pointer-coarse:h-11"
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
              <Download aria-hidden />
              Install tmuxde
            </Button>
          )}
        </SettingsRow>
      )}

      {availability === "manual" && (
        <SettingsRow
          label="Add to Home Screen"
          hint={
            <>
              Tap{" "}
              <Share className="inline h-3.5 w-3.5 align-[-2px]" aria-hidden />{" "}
              <strong className="font-medium text-foreground">Share</strong>,
              then{" "}
              <strong className="font-medium text-foreground">
                Add to Home Screen
              </strong>
              . You get a full height terminal with no browser chrome.
            </>
          }
        />
      )}

      {availability === "insecure" && (
        <SettingsRow
          label="Install as an app"
          hint="Installing needs HTTPS. Open tmuxde at its https:// address to install it."
        />
      )}
    </SettingsSection>
  );
}
