/**
 * The one place the client asks tmux to move its view.
 *
 * Scrolling is a round trip by necessity: the relay runs a real
 * `tmux attach-session`, so tmux owns the alternate screen and xterm's own
 * buffer is permanently empty (`apps/relay/src/tmux-manager.ts`). Every
 * affordance that scrolls — the touch drag in `TerminalGestureSurface`, the
 * wheel, and the rail's thumb — goes through here so they share one budget,
 * one set of guards and one belief about copy mode.
 *
 * The coalescing is the point. Each `tmux:scroll` costs the relay a couple of
 * `execFile` spawns of `tmux` plus a redraw back down the socket, so a raw
 * event-per-message stream from a wheel or a drag is both visibly laggy and
 * pointless — twenty a second is indistinguishable to a hand and a fraction of
 * the work.
 */

import { getRelayClient } from "@/hooks/use-websocket";
import { noteEnteredCopyMode } from "@/lib/copy-mode-belief";
import { useSessionStore } from "@/stores/session-store";

/** Longest a burst waits before the accumulated lines go on the wire. */
export const SCROLL_FLUSH_MS = 50;

/** The bound `tmux:scroll` is declared with; clamping beats being rejected. */
const MAX_LINES = 500;

let pendingLines = 0;
let flushTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * A live, attached socket, or null.
 *
 * Both halves matter, and for the same reason the gesture surface checked them
 * before it grew a shared home: `tmux:scroll` is dropped while disconnected,
 * so setting the copy-mode belief anyway invents a fact about a pane nothing
 * touched — and with no session attached the relay answers `NOT_ATTACHED`,
 * which is an error toast every 50ms for as long as a finger keeps moving.
 */
function scrollTarget(): { session: string } | null {
  const client = getRelayClient();
  if (!client || client.status !== "connected") return null;
  const session = useSessionStore.getState().activeSessionId;
  return session ? { session } : null;
}

/** Send whatever has accumulated. Safe to call with nothing pending. */
export function flushScroll(): void {
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  const lines = pendingLines;
  pendingLines = 0;
  if (lines === 0) return;
  const target = scrollTarget();
  if (!target) return;
  getRelayClient()?.send({
    type: "tmux:scroll",
    lines: Math.max(-MAX_LINES, Math.min(MAX_LINES, lines)),
  });
  noteEnteredCopyMode(target.session);
}

/** Scroll by `lines`, positive back into the past. Coalesced. */
export function scrollByLines(lines: number): void {
  if (lines === 0) return;
  pendingLines += lines;
  if (flushTimer === null) {
    flushTimer = setTimeout(flushScroll, SCROLL_FLUSH_MS);
  }
}

/** Drop anything a burst has accumulated but not yet sent. */
export function resetPendingScroll(): void {
  pendingLines = 0;
}

/**
 * Jump to an absolute point in the history, in lines back from the bottom.
 *
 * Not expressed as a delta: a thumb drag names a destination, and any delta
 * the client computes is stale the moment a line of output arrives mid-drag.
 * Pending relative lines are dropped rather than flushed — they describe a
 * journey the user has just overridden.
 */
export function scrollToPosition(position: number): void {
  // An old relay has no `tmux:scroll-to`; the rail is hidden there anyway, and
  // this is the guard that keeps a stray call from becoming a toast.
  if (support === "no") return;
  resetPendingScroll();
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  const target = scrollTarget();
  if (!target) return;
  getRelayClient()?.send({
    type: "tmux:scroll-to",
    position: Math.max(0, Math.round(position)),
  });
  noteEnteredCopyMode(target.session);
}

/*
 * Whether the machine on the other end knows what `tmux:scroll-state` is.
 *
 * It is a question because the two halves of this feature ship separately.
 * The client is deployed to app.mtmux.com; the relay that answers is the
 * `mtmux` CLI running on the user's own machine, upgraded whenever they get
 * round to it. A relay that predates these messages answers `INVALID_MESSAGE`
 * — which the app turns into a toast — so an ungated client would put an error
 * on screen for every scroll, on every machine that had not upgraded yet.
 *
 * Probed rather than derived from the reported CLI version: the honest test of
 * "does this relay answer" is asking it once, and a version constant would
 * have to be guessed here before the release that contains it exists.
 */
type Support = "unknown" | "yes" | "no";
let support: Support = "unknown";
let probeTimer: ReturnType<typeof setTimeout> | null = null;

/** How long an unanswered probe waits before the relay is called too old. */
const PROBE_TIMEOUT_MS = 4000;

/** Ask the relay where the attached pane's view currently sits. */
export function requestScrollState(): void {
  if (support === "no") return;
  if (!scrollTarget()) return;
  getRelayClient()?.send({ type: "tmux:scroll-state" });
  if (support === "yes" || probeTimer !== null) return;
  probeTimer = setTimeout(() => {
    probeTimer = null;
    // Silence, or an `INVALID_MESSAGE` that was never routed back to us. Both
    // mean the same thing, and both are answered by asking no more.
    if (support === "unknown") support = "no";
  }, PROBE_TIMEOUT_MS);
}

/** The relay answered, so it speaks these messages. Called by the socket hook. */
export function noteScrollStateReply(): void {
  support = "yes";
  if (probeTimer !== null) {
    clearTimeout(probeTimer);
    probeTimer = null;
  }
}

/**
 * Whether an `INVALID_MESSAGE` right now is one of ours to swallow.
 *
 * Narrow on purpose: true only while a probe this module sent is still
 * outstanding, so a genuinely malformed message from anywhere else still
 * reaches the user as the error it is.
 */
export function awaitingScrollStateProbe(): boolean {
  return probeTimer !== null;
}

/**
 * Forget what was learned — the next attach may be a different machine, and a
 * relay that could not answer is not evidence about the one after it.
 */
export function resetScrollSupport(): void {
  support = "unknown";
  if (probeTimer !== null) {
    clearTimeout(probeTimer);
    probeTimer = null;
  }
}

/** Test seam: the module-level burst outlives a test file otherwise. */
export function resetScrollForTests(): void {
  resetScrollSupport();
  resetPendingScroll();
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
}
