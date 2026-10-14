import type { ClientMessage, PaneInfo, SessionInfo, WindowInfo } from "@repo/protocol";

/**
 * The one derived array behind both the swipe gesture and the dots above the
 * terminal.
 *
 * These used to be two independent computations, and they disagreed: the dots
 * rendered `panes` while the gesture stepped `panes` of a *different* window,
 * which is what produced "the dot moves but the screen doesn't". Anything that
 * shows the strip and anything that steps it must go through here, so they
 * cannot drift apart again.
 *
 * Pure and DOM-free on purpose — the whole precedence table is testable
 * headless.
 */

export type StripKind = "window" | "pane" | "session";

export interface StripEntry {
  /** Stable identity: a tmux window/pane id, or a session name. */
  key: string;
  /** Short leading number, when the underlying thing has one. */
  index?: number;
  label: string;
  /** Panes in this window — only meaningful for `kind === "window"`. */
  paneCount?: number;
  /** This entry is the zoomed pane, or a window whose pane is zoomed. */
  zoomed?: boolean;
  /** tmux's own activity flag, for the unread marker. */
  activity?: boolean;
}

export interface Strip {
  kind: StripKind;
  entries: StripEntry[];
  /** -1 when nothing in `entries` is currently active. */
  activeIndex: number;
}

export interface GestureFlags {
  swipeToSwitchSessions: boolean;
  swipeToSwitchPanes: boolean;
}

export interface StripInput {
  windows: WindowInfo[];
  panes: PaneInfo[];
  activeWindowId: string | null;
  activePaneId: string | null;
  zoomedPaneId: string | null;
  sessions: SessionInfo[];
  activeSessionId: string | null;
  gestures: GestureFlags;
}

/** What a swipe should actually do. Dispatch lives at the call site. */
export type StripAction =
  | { send: ClientMessage }
  | { setSession: string };

const EMPTY: Strip = { kind: "window", entries: [], activeIndex: -1 };

/**
 * Which layer a horizontal swipe steps, and what the dots therefore show.
 *
 * Windows first. A window switch is the only one of the three that reliably
 * *changes what is on the screen* — tmux has already drawn every pane of the
 * current window, so stepping panes in an unzoomed window is invisible, which
 * is why the old pane-first model felt broken even when it worked.
 *
 * | situation                              | strip    |
 * | -------------------------------------- | -------- |
 * | more than one window                   | windows  |
 * | one window, a pane zoomed, >1 pane     | panes    |
 * | one window, one pane, >1 session       | sessions |
 */
export function resolveStrip(input: StripInput): Strip {
  const { windows, panes, gestures } = input;

  if (windows.length > 1) {
    const zoomedWindowId = input.zoomedPaneId
      ? (panes.find((p) => p.id === input.zoomedPaneId)?.windowId ?? null)
      : null;
    return {
      kind: "window",
      entries: windows.map((w) => ({
        key: w.id,
        index: w.index,
        label: w.name,
        paneCount: w.paneCount,
        zoomed: w.id === zoomedWindowId,
        activity: w.activity,
      })),
      activeIndex: windows.findIndex((w) => w.id === input.activeWindowId),
    };
  }

  // A single window: panes are only worth stepping when one is zoomed, because
  // that is the only time stepping them redraws anything.
  if (gestures.swipeToSwitchPanes && input.zoomedPaneId && panes.length > 1) {
    return {
      kind: "pane",
      entries: panes.map((p) => ({
        key: p.id,
        index: p.index,
        label: p.command || `pane ${p.index}`,
        zoomed: p.id === input.zoomedPaneId,
      })),
      activeIndex: panes.findIndex((p) => p.id === input.activePaneId),
    };
  }

  if (
    gestures.swipeToSwitchSessions &&
    windows.length <= 1 &&
    panes.length <= 1 &&
    input.sessions.length > 1
  ) {
    return {
      kind: "session",
      entries: input.sessions.map((s) => ({
        key: s.name,
        label: s.name,
      })),
      activeIndex: input.sessions.findIndex(
        (s) => s.name === input.activeSessionId,
      ),
    };
  }

  return EMPTY;
}

/** The entry a step in `direction` would land on, or null if it cannot move. */
export function stepTarget(
  strip: Strip,
  direction: 1 | -1,
): StripEntry | null {
  const n = strip.entries.length;
  if (n < 2 || strip.activeIndex < 0) return null;
  const next = (strip.activeIndex + direction + n) % n;
  return strip.entries[next] ?? null;
}

/**
 * Translate a swipe into a single action.
 *
 * Window and pane steps are sent *relative* (`window:step` / `pane:step`)
 * rather than as "select this id": the relay resolves them against live tmux
 * state, so a strip that went stale between render and swipe still lands
 * somewhere sensible instead of on a window that no longer exists.
 *
 * `supportsStep` is false against a relay that predates those two messages —
 * which is most of them, since the browser updates the moment we deploy and
 * the CLI updates when its user feels like it. Such a relay answers
 * `INVALID_MESSAGE`, so the swipe would silently do nothing; the id-based
 * form it has always understood is used instead. That fallback is lossless
 * for windows, and for panes only loses zoom preservation — which is the
 * behaviour of those relays regardless.
 */
export function resolveStep(
  strip: Strip,
  direction: 1 | -1,
  supportsStep = true,
): StripAction | null {
  const target = stepTarget(strip, direction);
  if (!target) return null;

  switch (strip.kind) {
    case "window":
      return supportsStep
        ? { send: { type: "window:step", delta: direction } }
        : { send: { type: "window:select", id: target.key } };
    case "pane":
      return supportsStep
        ? { send: { type: "pane:step", delta: direction } }
        : { send: { type: "pane:select", id: target.key } };
    case "session":
      return { setSession: target.key };
  }
}
