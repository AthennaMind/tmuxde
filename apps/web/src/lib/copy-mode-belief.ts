/**
 * What we think tmux's copy mode is doing, per session.
 *
 * Copy mode matters to the client for one reason: keystrokes sent to a pane in
 * copy mode are copy-mode *commands*, not input. So after a drag-to-scroll —
 * which works by entering copy mode (`apps/relay/src/tmux-manager.ts`) — a tap
 * has to send `tmux:exit-copy-mode` first, or the terminal looks focused and
 * silently eats everything the user types.
 *
 * This is a belief, not a source of truth, and it is keyed by session on
 * purpose. A single boolean got both directions wrong: scrolling in session A
 * and then tapping in session B sent the exit to B while leaving A stuck, and
 * entering copy mode from the FAB never set it at all, so the tap that was
 * supposed to rescue the user did nothing.
 *
 * It is deliberately *not* cleared on disconnect. Copy mode lives in tmux, not
 * in the client, and survives a browser reconnect — forgetting on a dropped
 * socket would recreate the same stuck-terminal bug on every blip.
 *
 * The remaining inaccuracy is one-directional and cheap: tmux leaves copy mode
 * by itself once the view reaches the live output, and the user can leave it
 * from a keyboard, so the belief can over-report. The cost of over-reporting is
 * one no-op round trip — `exitCopyMode` checks `pane_in_mode` before acting.
 */

const sessionsInCopyMode = new Set<string>();

/**
 * Subscribers, so the belief can be *shown* and not merely consulted.
 *
 * It was write-and-check-later state for as long as its only reader was the
 * tap handler that rescues a stuck terminal. But the honest fix for "the
 * terminal looks focused and silently eats everything the user types" is to
 * stop it looking focused — which means something on screen has to re-render
 * when this changes. Hence a store, in the smallest form that is still one:
 * `useSyncExternalStore` over the Set that was already here.
 */
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function subscribeCopyModeBelief(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function noteEnteredCopyMode(session: string | null | undefined): void {
  if (!session || sessionsInCopyMode.has(session)) return;
  sessionsInCopyMode.add(session);
  emit();
}

export function noteLeftCopyMode(session: string | null | undefined): void {
  if (!session || !sessionsInCopyMode.delete(session)) return;
  emit();
}

export function believedInCopyMode(
  session: string | null | undefined,
): boolean {
  return session ? sessionsInCopyMode.has(session) : false;
}

/** Test-only: the set is module state and outlives a test file otherwise. */
export function resetCopyModeBeliefForTests(): void {
  sessionsInCopyMode.clear();
  emit();
}
