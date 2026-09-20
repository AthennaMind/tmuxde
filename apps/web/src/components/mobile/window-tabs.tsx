"use client";

import { useEffect, useRef } from "react";
import { Plus, LayoutGrid, Maximize2 } from "lucide-react";
import { cn } from "@repo/ui/lib/utils";
import { getRelayClient } from "@/hooks/use-websocket";
import { selectStripEntry } from "@/lib/strip-controller";
import { resolveStrip } from "@/lib/switch-strip";
import { usePaneStore } from "@/stores/pane-store";
import { useSessionStore } from "@/stores/session-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useUiStore } from "@/stores/ui-store";
import { useConnectionStore } from "@/stores/connection-store";

interface WindowTabsProps {
  className?: string;
}

/**
 * The strip above the terminal: what a horizontal swipe steps, drawn.
 *
 * It renders `resolveStrip` — the *same* function the gesture commits through
 * — rather than deriving its own list. That is deliberate and load-bearing:
 * when the dots were `panes.map(...)` and the swipe stepped something else,
 * the two silently disagreed and the highlight moved over a screen that never
 * changed.
 */
export function WindowTabs({ className }: WindowTabsProps) {
  // One selector per field. This bar sits directly above the terminal and is
  // never unmounted, so an unselected subscription re-renders it on every
  // write to either store — including the font-size churn a pinch produces.
  const windows = usePaneStore((s) => s.windows);
  const panes = usePaneStore((s) => s.panes);
  const activeWindowId = usePaneStore((s) => s.activeWindowId);
  const activePaneId = usePaneStore((s) => s.activePaneId);
  const zoomedPaneId = usePaneStore((s) => s.zoomedPaneId);
  const pendingKey = usePaneStore((s) => s.pendingKey);
  const sessions = useSessionStore((s) => s.sessions);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const gestures = useSettingsStore((s) => s.gestures);
  const setPaneListOpen = useUiStore((s) => s.setPaneListOpen);
  const setFabOpen = useUiStore((s) => s.setFabOpen);
  const connected = useConnectionStore((s) => s.status === "connected");
  const activeRef = useRef<HTMLButtonElement | null>(null);
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Built from the subscribed fields rather than read out of the stores
  // imperatively, so React re-renders whenever any input to the strip moves.
  const strip = resolveStrip({
    windows,
    panes,
    activeWindowId,
    activePaneId,
    zoomedPaneId,
    sessions,
    activeSessionId,
    gestures,
  });

  const activeKey =
    pendingKey ?? strip.entries[strip.activeIndex]?.key ?? undefined;

  // Wrapping a strip of eight windows off the right edge and leaving the
  // highlight off-screen is the same failure as no highlight at all.
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest", inline: "center" });
  }, [activeKey]);

  useEffect(
    () => () => {
      if (pressTimer.current) clearTimeout(pressTimer.current);
    },
    [],
  );

  if (!activeSessionId) return null;

  const handleCreateWindow = () => {
    getRelayClient()?.send({ type: "window:create" });
  };

  /**
   * Long-press: select the entry, then open the FAB.
   *
   * Rename and kill already live there, already target the active window, and
   * already put a destructive kill behind a named confirmation. Duplicating
   * either here would mean a second, weaker confirm path for the same action.
   *
   * The timer is a ref, not a closure variable: pointerdown and pointerup can
   * land in different renders, and a per-render closure would leave the press
   * uncancellable when they do.
   */
  const cancelPress = () => {
    if (pressTimer.current) clearTimeout(pressTimer.current);
    pressTimer.current = null;
  };

  const longPress = (key: string) => ({
    onPointerDown: () => {
      cancelPress();
      pressTimer.current = setTimeout(() => {
        pressTimer.current = null;
        selectStripEntry(key);
        setFabOpen(true);
      }, 500);
    },
    onPointerUp: cancelPress,
    onPointerLeave: cancelPress,
    onPointerCancel: cancelPress,
  });

  const showStrip = strip.entries.length > 1;
  const soleWindow = windows.length === 1 ? windows[0] : undefined;

  /*
   * The row is not the tablist, and the two used to be the same element.
   *
   * `role="tablist"` requires that its children be tabs. This row also holds
   * "Create window", a spacer and the pane-list button, so axe reported
   * `aria-required-children` on every single stop of a sweep — a real failure,
   * not a pedantic one: a screen reader announces "tab list, 13 items" and
   * then reads two of them as buttons that are not tabs, which is a lie about
   * how many windows there are.
   *
   * `min-h-11` rather than `h-11`, for the other half of the same bug. Tailwind
   * boxes are `border-box`, so `h-11` *plus* `border-b` is a 43px content area
   * — and every tab, being `h-full`, was 43px tall against a 44px floor. The
   * comment that used to live here said the buttons filled the row so the tap
   * target cleared 44px; it was right about the intent and wrong by one pixel,
   * for two years, on every window tab in the app.
   */
  const stripLabel =
    strip.kind === "window"
      ? "Windows"
      : strip.kind === "pane"
        ? "Panes"
        : "Sessions";

  return (
    <div
      className={cn(
        "flex min-h-11 shrink-0 items-center gap-1 px-2 border-b",
        className,
      )}
    >
      {showStrip ? (
        <div
          role="tablist"
          aria-label={stripLabel}
          // `touch-pan-x` states this row's own intent: it is a real
          // horizontal scroller. `min-w-0` is what lets it actually shrink
          // inside the flex row rather than pushing the buttons off-screen.
          className="flex min-w-0 flex-1 touch-pan-x items-center gap-1 self-stretch overflow-x-auto scrollbar-none"
        >
          {strip.entries.map((entry) => {
            const isActive = entry.key === activeKey;
            const isPending = entry.key === pendingKey;
            return (
              <button
                key={entry.key}
                ref={isActive ? activeRef : undefined}
                role="tab"
                aria-selected={isActive}
                // The full name, for a tab whose visible label is clipped to
                // 80px. Two sessions called `mtmux-web-1` and `mtmux-web-2`
                // are otherwise the same tab twice.
                title={entry.label}
                className="group flex h-11 shrink-0 items-center rounded-md disabled:opacity-50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                disabled={!connected}
                onClick={() => selectStripEntry(entry.key)}
                {...(strip.kind === "window" ? longPress(entry.key) : {})}
              >
                <span
                  className={cn(
                    "flex items-center gap-1 rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                    isActive
                      ? "bg-primary text-primary-foreground"
                      : "bg-secondary text-secondary-foreground group-hover:bg-accent",
                    // The switch is on the wire but unconfirmed. Dimmed rather
                    // than un-highlighted: the user is told where they are
                    // going and that it has not landed yet.
                    isPending && "opacity-70",
                  )}
                >
                  {entry.index !== undefined && (
                    <span className="text-[11px] opacity-60">
                      {entry.index}
                    </span>
                  )}
                  <span className="max-w-[80px] truncate">{entry.label}</span>
                  {entry.zoomed && (
                    <Maximize2 className="h-2.5 w-2.5" aria-label="Zoomed" />
                  )}
                  {entry.paneCount !== undefined && entry.paneCount > 1 && (
                    <span
                      className="text-[11px] opacity-60"
                      title={`${entry.paneCount} panes`}
                    >
                      ·{entry.paneCount}
                    </span>
                  )}
                  {entry.activity && !isActive && (
                    <span
                      className="h-1.5 w-1.5 rounded-full bg-primary"
                      aria-label="Activity"
                    />
                  )}
                </span>
              </button>
            );
          })}
        </div>
      ) : soleWindow ? (
        <span
          className="flex-1 truncate text-xs text-muted-foreground"
          title={soleWindow.name}
        >
          {soleWindow.name}
        </span>
      ) : (
        <div className="flex-1" />
      )}

      {showStrip && strip.kind === "window" && (
        <button
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent transition-colors disabled:opacity-50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          onClick={handleCreateWindow}
          disabled={!connected}
          aria-label="Create window"
          title={connected ? "Create window" : "Not connected"}
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      )}

      {/* Pane indicator button — always clickable to open PaneListPanel */}
      <button
        className="flex h-11 shrink-0 items-center gap-1 rounded-md px-2 text-xs text-muted-foreground hover:bg-accent transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        onClick={() => setPaneListOpen(true)}
        aria-label={zoomedPaneId ? "Hide pane list" : "Show pane list"}
      >
        {zoomedPaneId ? (
          <Maximize2 className="h-3.5 w-3.5 text-primary" />
        ) : (
          <LayoutGrid className="h-3.5 w-3.5" />
        )}
        <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-muted text-[11px] font-medium px-1">
          {panes.length || 1}
        </span>
      </button>
    </div>
  );
}
