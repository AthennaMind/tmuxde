import { triggerHaptic } from "@repo/ui/components/haptic-button";
import { getRelayClient } from "@/hooks/use-websocket";
import { LAST_SESSION_KEY, writeStored } from "@/lib/storage-keys";
import {
  resolveStep,
  resolveStrip,
  stepTarget,
  type Strip,
  type StripEntry,
} from "@/lib/switch-strip";
import {
  supportsStep,
  useConnectionStore,
} from "@/stores/connection-store";
import { usePaneStore } from "@/stores/pane-store";
import { useSessionStore } from "@/stores/session-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useUiStore } from "@/stores/ui-store";

/**
 * The one path from "the user asked to switch" to "something is on the wire".
 *
 * Both the swipe and a tap on the tab strip go through here, so the optimistic
 * highlight, the in-flight guard, the haptic and the HUD are identical however
 * the switch was asked for.
 */

/**
 * How long an unconfirmed switch stays highlighted.
 *
 * Long enough to cover a sealed-tunnel round trip, short enough that a dropped
 * reply does not leave the strip lying about where you are.
 */
const PENDING_TIMEOUT_MS = 2500;

let pendingTimer: ReturnType<typeof setTimeout> | null = null;
let hudTimer: ReturnType<typeof setTimeout> | null = null;

/** Current strip, read live from the stores. */
export function currentStrip(): Strip {
  const pane = usePaneStore.getState();
  const session = useSessionStore.getState();
  const { gestures } = useSettingsStore.getState();
  return resolveStrip({
    windows: pane.windows,
    panes: pane.panes,
    activeWindowId: pane.activeWindowId,
    activePaneId: pane.activePaneId,
    zoomedPaneId: pane.zoomedPaneId,
    sessions: session.sessions,
    activeSessionId: session.activeSessionId,
    gestures,
  });
}

function entryLabel(strip: Strip, entry: StripEntry): string {
  if (strip.kind === "session") return entry.label;
  return entry.index === undefined
    ? entry.label
    : `${entry.index} · ${entry.label}`;
}

function showHud(text: string) {
  useUiStore.getState().setSwitchHint(text);
  if (hudTimer) clearTimeout(hudTimer);
  hudTimer = setTimeout(() => {
    useUiStore.getState().setSwitchHint(null);
    hudTimer = null;
  }, 1200);
}

function beginPending(key: string) {
  usePaneStore.getState().setPendingKey(key);
  if (pendingTimer) clearTimeout(pendingTimer);
  pendingTimer = setTimeout(() => {
    // Reverting rather than keeping the guess: an unanswered switch that stays
    // highlighted is worse than one that visibly did not happen.
    usePaneStore.getState().setPendingKey(null);
    pendingTimer = null;
  }, PENDING_TIMEOUT_MS);
}

/** True while a committed switch is still waiting for the relay to confirm. */
function isPending(): boolean {
  return usePaneStore.getState().pendingKey !== null && pendingTimer !== null;
}

/**
 * Step the strip one entry in `direction` (+1 forward, -1 back).
 *
 * Returns whether anything was sent, so a caller can fall back.
 */
export function stepStrip(direction: 1 | -1): boolean {
  // A second swipe while the first is unanswered would step twice from a state
  // that has not moved yet, overshooting the target the user was watching.
  if (isPending()) return false;

  const strip = currentStrip();
  const action = resolveStep(
    strip,
    direction,
    supportsStep(useConnectionStore.getState().features),
  );
  if (!action) return false;
  const target = stepTarget(strip, direction);

  if ("setSession" in action) {
    const { setActiveSession } = useSessionStore.getState();
    setActiveSession(action.setSession);
    writeStored(LAST_SESSION_KEY, action.setSession);
  } else {
    const client = getRelayClient();
    if (!client || client.status !== "connected") return false;
    client.send(action.send);
    if (target) beginPending(target.key);
  }

  if (target) showHud(entryLabel(strip, target));
  if (useSettingsStore.getState().hapticEnabled) triggerHaptic(15);
  return true;
}

/** Jump straight to a strip entry — the tab strip's tap handler. */
export function selectStripEntry(key: string): boolean {
  const strip = currentStrip();
  const entry = strip.entries.find((e) => e.key === key);
  if (!entry) return false;
  if (strip.activeIndex >= 0 && strip.entries[strip.activeIndex]?.key === key) {
    return false;
  }

  if (strip.kind === "session") {
    useSessionStore.getState().setActiveSession(key);
    writeStored(LAST_SESSION_KEY, key);
  } else {
    const client = getRelayClient();
    if (!client || client.status !== "connected") return false;
    client.send(
      strip.kind === "window"
        ? { type: "window:select", id: key }
        : { type: "pane:select", id: key },
    );
    beginPending(key);
  }

  showHud(entryLabel(strip, entry));
  if (useSettingsStore.getState().hapticEnabled) triggerHaptic(15);
  return true;
}

/** Test seam: drop the module-level timers between cases. */
export function resetStripController(): void {
  if (pendingTimer) clearTimeout(pendingTimer);
  if (hudTimer) clearTimeout(hudTimer);
  pendingTimer = null;
  hudTimer = null;
}
