import { getRelayClient } from "@/hooks/use-websocket";
import { usePaneStore } from "@/stores/pane-store";

/**
 * Zoom a pane, by naming the pane and the state wanted.
 *
 * ## Why this is not `send({ type: "pane:zoom" })`
 *
 * It used to be, from four call sites, and the message carried neither a pane
 * id nor a desired state. The relay turned it into `resize-pane -Z` against
 * whatever tmux considered the session's current pane, which is a *toggle*.
 * Two consequences, both of which users hit:
 *
 * - **A second tap undid the first.** The zoom button is drawn from
 *   `zoomedPaneId`, which only updates when the relay's `pane:list` lands. Tap
 *   twice inside that round trip — trivially easy over a sealed tunnel — and
 *   two toggles arrive where the user asked for one thing twice. The button
 *   then shows the opposite of the truth until the next announcement. This is
 *   the reported "sometimes zoom unzoom does not work".
 * - **It could zoom the wrong pane.** The pane the user tapped and the pane
 *   tmux had active are not always the same one, most obviously in the pane
 *   list where tapping a row selects *and* zooms.
 *
 * Naming both makes the request idempotent: the relay reads the current flag
 * and only acts if it disagrees, so N taps and one tap land in the same place.
 * `id` and `zoomed` are optional on the wire, so an older relay bundled in an
 * older CLI still gets a toggle it understands.
 *
 * The local `setZoomedPane` is optimism, not truth — it makes the button
 * answer the tap immediately, and the relay's announcement reconciles it a
 * moment later either way.
 */
export function zoomPane(opts: { id?: string; zoomed?: boolean } = {}): void {
  const client = getRelayClient();
  if (!client || client.status !== "connected") return;

  const { activePaneId, zoomedPaneId } = usePaneStore.getState();
  const id = opts.id ?? activePaneId ?? undefined;
  // Without an explicit wish, the wish is "the other state from now" — asked
  // about this pane, not about the window, so tapping an unzoomed pane while a
  // different one is zoomed moves the zoom rather than turning it off.
  const zoomed =
    opts.zoomed ?? (id ? zoomedPaneId !== id : zoomedPaneId === null);

  client.send({ type: "pane:zoom", ...(id ? { id } : {}), zoomed });
  usePaneStore.getState().setZoomedPane(zoomed ? (id ?? null) : null);
}
