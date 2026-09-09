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

  return (
    <div
      className={cn(
        // Fixed 44px row: the tabs stay visually compact pills but each button
        // fills the row height so the tap target clears the 44px minimum.
        // `touch-pan-x` states this row's own intent: it is a real horizontal
        // scroller, and it used to inherit `pan-y` from a wrapper that no
        // longer exists.
        "flex h-11 shrink-0 touch-pan-x items-center gap-1 overflow-x-auto px-2 border-b scrollbar-none",
        className,
      )}
      role="tablist"
      aria-label={
        strip.kind === "window"
          ? "Windows"
          : strip.kind === "pane"
            ? "Panes"
            : "Sessions"
      }
    >
      {showStrip ? (
        <>
          {strip.entries.map((entry) => {
            const isActive = entry.key === activeKey;
            const isPending = entry.key === pendingKey;
            return (
              <button
                key={entry.key}
                ref={isActive ? activeRef : undefined}
                role="tab"
                aria-selected={isActive}
                className="group flex h-full shrink-0 items-center rounded-md disabled:opacity-50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
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
                    <span className="text-[10px] opacity-60">{entry.index}</span>
                  )}
                  <span className="max-w-[80px] truncate">{entry.label}</span>
                  {entry.zoomed && (
                    <Maximize2 className="h-2.5 w-2.5" aria-label="Zoomed" />
                  )}
                  {entry.paneCount !== undefined && entry.paneCount > 1 && (
                    <span className="text-[10px] opacity-60">
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
          {strip.kind === "window" && (
            <button
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent transition-colors disabled:opacity-50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              onClick={handleCreateWindow}
              disabled={!connected}
              aria-label="Create window"
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
          )}
        </>
      ) : soleWindow ? (
        <span className="text-xs text-muted-foreground truncate max-w-[120px]">
          {soleWindow.name}
        </span>
      ) : null}

      <div className="flex-1" />

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
        <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-muted text-[10px] font-medium px-1">
          {panes.length || 1}
        </span>
      </button>
    </div>
  );
}
