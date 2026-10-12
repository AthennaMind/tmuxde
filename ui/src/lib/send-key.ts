import { triggerHaptic } from "@repo/ui/components/haptic-button";
import { getRelayClient } from "@/hooks/use-websocket";
import { useSettingsStore } from "@/stores/settings-store";

/**
 * Write a raw key sequence to the terminal.
 *
 * `terminal:input` rather than `command:send`, and the distinction matters: a
 * key is bytes for whatever is in the foreground, not a line for a shell to
 * run. `\x1b[Z` is meaningless to `command:send`'s history and bracketed-paste
 * handling, and `sendCommand` would trim it to nothing.
 *
 * Lives here rather than inside the toolbar because the key sheet sends the
 * same way, and the haptic and the connected check are exactly the parts a
 * second copy would drift on.
 *
 * Returns whether it reached the socket, so a caller can stay quiet instead of
 * pretending a dead connection worked.
 */
export function sendKeySequence(data: string): boolean {
  if (!data) return false;
  const client = getRelayClient();
  if (!client || client.status !== "connected") return false;
  if (useSettingsStore.getState().hapticEnabled) triggerHaptic();
  client.send({ type: "terminal:input", data });
  return true;
}
