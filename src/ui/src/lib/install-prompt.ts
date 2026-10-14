/**
 * Whether this device can install the app, and the one-shot prompt if it can.
 *
 * Two things make this more than a boolean. First, `beforeinstallprompt` fires
 * once, early, and is unusable unless something captured it at that moment —
 * so the capture lives in a module singleton that the root layout arms on first
 * paint, not in the component that eventually renders a button. Second, iOS has
 * no prompt API at all: the only path is the share sheet, which means the only
 * way an iPhone user ever learns the app is installable is if we tell them.
 *
 * The decision itself is a pure function of four observations so it can be
 * tested without a browser; the observing is done by the hook.
 */

type InstallOutcome = "accepted" | "dismissed";

/** Not in lib.dom — Chromium-only, and still non-standard. */
export interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  readonly userChoice: Promise<{ outcome: InstallOutcome }>;
}

export type InstallAvailability =
  /** Already running as an installed app. */
  | "installed"
  /** Chromium handed us a prompt; a button can call `promptInstall`. */
  | "prompt"
  /** iOS: no API, so show the share-sheet instructions instead. */
  | "manual"
  /**
   * Served over plain http, which is the LAN self-hosted path. No browser will
   * install from a non-secure origin, and saying so beats a button that does
   * nothing.
   */
  | "insecure"
  | "unavailable";

export interface InstallInputs {
  standalone: boolean;
  hasPrompt: boolean;
  iosDevice: boolean;
  secureContext: boolean;
}

export function installAvailability({
  standalone,
  hasPrompt,
  iosDevice,
  secureContext,
}: InstallInputs): InstallAvailability {
  if (standalone) return "installed";
  if (hasPrompt) return "prompt";
  // Checked before `secureContext` on purpose: iOS "Add to Home Screen" works
  // from a plain-http origin, so a phone on the LAN can still install even
  // though Chromium's criteria would refuse.
  if (iosDevice) return "manual";
  if (!secureContext) return "insecure";
  return "unavailable";
}

/** True for iPhone, iPod, and iPadOS — which reports itself as a Mac. */
export function isIosDevice(nav: {
  userAgent: string;
  platform?: string;
  maxTouchPoints?: number;
}): boolean {
  if (/iPad|iPhone|iPod/.test(nav.userAgent)) return true;
  // iPadOS 13+ ships a desktop UA string. A touch-capable "Mac" is an iPad.
  return nav.platform === "MacIntel" && (nav.maxTouchPoints ?? 0) > 1;
}

interface InstallSnapshot {
  hasPrompt: boolean;
  installed: boolean;
}

/**
 * Frozen and shared. `useSyncExternalStore` compares snapshots by identity and
 * loops forever if the getter allocates, and the server getter must be stable
 * across renders for the same reason.
 */
const EMPTY: InstallSnapshot = Object.freeze({
  hasPrompt: false,
  installed: false,
});

let deferred: BeforeInstallPromptEvent | null = null;
let snapshot: InstallSnapshot = EMPTY;
const listeners = new Set<() => void>();

function publish(next: InstallSnapshot) {
  if (
    next.hasPrompt === snapshot.hasPrompt &&
    next.installed === snapshot.installed
  ) {
    return;
  }
  snapshot = Object.freeze(next);
  for (const listener of listeners) listener();
}

export function subscribeInstall(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getInstallSnapshot(): InstallSnapshot {
  return snapshot;
}

export function getServerInstallSnapshot(): InstallSnapshot {
  return EMPTY;
}

export function captureInstallPrompt(event: BeforeInstallPromptEvent): void {
  deferred = event;
  publish({ hasPrompt: true, installed: snapshot.installed });
}

export function markInstalled(): void {
  deferred = null;
  publish({ hasPrompt: false, installed: true });
}

/**
 * Show the browser's install dialog.
 *
 * The captured event is single-use: whatever the user chooses, Chromium will
 * not accept a second `prompt()` on it, so it is cleared either way.
 */
export async function promptInstall(): Promise<InstallOutcome | "unavailable"> {
  const event = deferred;
  if (!event) return "unavailable";
  deferred = null;
  publish({ hasPrompt: false, installed: snapshot.installed });
  try {
    await event.prompt();
    const { outcome } = await event.userChoice;
    return outcome;
  } catch {
    return "unavailable";
  }
}

/** Test-only: the singleton outlives a test file otherwise. */
export function resetInstallPromptForTests(): void {
  deferred = null;
  snapshot = EMPTY;
  listeners.clear();
}
