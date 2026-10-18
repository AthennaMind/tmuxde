import * as React from "react";
import { cn } from "@/shared/utils";

/** Smallest the thumb is allowed to get, so a long list stays grabbable. */
const MIN_THUMB_PX = 28;

/** How long the bar stays up after the last scroll event. */
const IDLE_HIDE_MS = 800;

export type MiniScrollbarOrientation = "vertical" | "horizontal";

interface MiniScrollbarProps {
  /** The scrolling element this bar describes. */
  target: HTMLElement | null;
  orientation?: MiniScrollbarOrientation;
  className?: string;
}

interface Metrics {
  /** Scroll offset, in px. */
  offset: number;
  /** Total scrollable length, in px. */
  total: number;
  /** Visible length, in px. */
  visible: number;
}

const ZERO: Metrics = { offset: 0, total: 0, visible: 0 };

/**
 * The target's scroll geometry along one axis, as an external store.
 *
 * It notifies on scroll, on resize, and on content change. All three are
 * needed and none implies the others: scrolling moves the thumb, resizing the
 * box changes its size, and a list that gains rows changes `scrollHeight`
 * without either event firing. The last is the common case here. These
 * panels are filled asynchronously from the relay.
 *
 * Dragging the thumb scrolls through the store as well, so reads and writes
 * of the element's scroll position live in one place.
 */
function scrollGeometry(target: HTMLElement | null, vertical: boolean) {
  let last = ZERO;

  const subscribe = (notify: () => void) => {
    if (!target) return () => {};
    target.addEventListener("scroll", notify, { passive: true });

    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(notify);
      observer.observe(target);
      // The content, not just the box: a Radix viewport wraps its children in
      // a div, and that is the node whose height actually changes.
      const content = target.firstElementChild;
      if (content) observer.observe(content);
    }

    let mutations: MutationObserver | null = null;
    if (typeof MutationObserver !== "undefined") {
      mutations = new MutationObserver(notify);
      mutations.observe(target, { childList: true, subtree: true });
    }

    return () => {
      target.removeEventListener("scroll", notify);
      observer?.disconnect();
      mutations?.disconnect();
    };
  };

  const getSnapshot = (): Metrics => {
    if (!target) return ZERO;
    const offset = vertical ? target.scrollTop : target.scrollLeft;
    const total = vertical ? target.scrollHeight : target.scrollWidth;
    const visible = vertical ? target.clientHeight : target.clientWidth;
    // Same numbers, same object, so an unrelated notify does not re-render.
    if (offset !== last.offset || total !== last.total || visible !== last.visible) {
      last = { offset, total, visible };
    }
    return last;
  };

  const scrollTo = (offset: number) => {
    if (!target) return;
    if (vertical) target.scrollTop = offset;
    else target.scrollLeft = offset;
  };

  return { subscribe, getSnapshot, scrollTo };
}

/**
 * A thin overlay scrollbar for any scrolling element.
 *
 * The app had no scroll affordance on touch at all. Radix's `ScrollArea` is
 * configured `type="auto"`, but its bar is a 10px inset track that only some
 * panels use, and the rest of the app scrolls raw `overflow-y-auto` divs whose
 * native bar mobile browsers do not draw. So every list — sessions, files,
 * settings, the pane sheet — was a surface with no sign that there was anything
 * below the fold, and nothing to drag.
 *
 * Deliberately an *overlay*: it is positioned over the content rather than
 * taking layout width, so adding one never reflows the thing it decorates and
 * a call site needs no other change.
 *
 * The geometry is in pixels, not percentages, for the reason
 * `TerminalScrollRail` records: a thumb clamped up to `MIN_THUMB_PX` no longer
 * covers the fraction its percentage claims, so a percentage offset walks it
 * off the end exactly when the user has scrolled to the bottom.
 *
 * Hit-testing is off until the bar is actually showing. An invisible grab strip
 * down the edge of every list would swallow taps meant for the rows underneath,
 * which on a phone is a far worse bug than the one this fixes.
 */
export function MiniScrollbar({ target, orientation = "vertical", className }: MiniScrollbarProps) {
  const vertical = orientation === "vertical";
  const geometry = React.useMemo(() => scrollGeometry(target, vertical), [target, vertical]);
  const metrics = React.useSyncExternalStore(geometry.subscribe, geometry.getSnapshot);
  const [railLength, setRailLength] = React.useState(0);
  const [active, setActive] = React.useState(false);
  const [dragging, setDragging] = React.useState(false);
  const railRef = React.useRef<HTMLDivElement | null>(null);
  const hideTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Where in the thumb the pointer grabbed it, so a drag does not jump. */
  const grabOffset = React.useRef(0);

  const show = React.useCallback(() => {
    setActive(true);
    if (hideTimer.current !== null) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => {
      hideTimer.current = null;
      setActive(false);
    }, IDLE_HIDE_MS);
  }, []);

  React.useEffect(
    () => () => {
      if (hideTimer.current !== null) clearTimeout(hideTimer.current);
    },
    [],
  );

  // Scrolling brings the bar up for a moment.
  React.useEffect(() => {
    if (!target) return;
    target.addEventListener("scroll", show, { passive: true });
    return () => target.removeEventListener("scroll", show);
  }, [target, show]);

  /*
   * The rail is measured from a ref callback, not a mount effect.
   *
   * It renders nothing until there is something to scroll, so a mount effect
   * runs while the rail does not exist — and with an empty dependency list it
   * never runs again once it does. The length stayed 0, which floors the thumb
   * at its minimum and collapses the travel to nothing. React calls a ref
   * callback with the node exactly when it attaches it.
   */
  const railObserver = React.useRef<ResizeObserver | null>(null);
  const measureRail = React.useCallback(
    (node: HTMLDivElement | null) => {
      railRef.current = node;
      railObserver.current?.disconnect();
      railObserver.current = null;
      if (!node) return;
      const read = () => setRailLength(vertical ? node.clientHeight : node.clientWidth);
      read();
      if (typeof ResizeObserver === "undefined") return;
      const observer = new ResizeObserver(read);
      observer.observe(node);
      railObserver.current = observer;
    },
    [vertical],
  );

  React.useEffect(() => () => railObserver.current?.disconnect(), []);

  const scrollable = metrics.total - metrics.visible > 1;
  const thumbPx = scrollable
    ? Math.max(MIN_THUMB_PX, Math.round((metrics.visible / metrics.total) * railLength))
    : 0;
  const travelPx = Math.max(0, railLength - thumbPx);
  const maxOffset = Math.max(1, metrics.total - metrics.visible);
  const thumbStartPx = Math.round((Math.min(metrics.offset, maxOffset) / maxOffset) * travelPx);

  const scrollToPointer = React.useCallback(
    (clientPos: number) => {
      const rail = railRef.current;
      if (!rail || travelPx <= 0) return;
      const rect = rail.getBoundingClientRect();
      const railStart = vertical ? rect.top : rect.left;
      const start = Math.min(travelPx, Math.max(0, clientPos - railStart - grabOffset.current));
      geometry.scrollTo((start / travelPx) * maxOffset);
    },
    [geometry, travelPx, maxOffset, vertical],
  );

  const onPointerDown = React.useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!scrollable) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      event.preventDefault();
      event.stopPropagation();
      const rect = event.currentTarget.getBoundingClientRect();
      grabOffset.current = vertical ? event.clientY - rect.top : event.clientX - rect.left;
      setDragging(true);
      show();
    },
    [scrollable, vertical, show],
  );

  const onPointerMove = React.useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!dragging) return;
      event.preventDefault();
      scrollToPointer(vertical ? event.clientY : event.clientX);
      show();
    },
    [dragging, scrollToPointer, vertical, show],
  );

  const endDrag = React.useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!dragging) return;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      setDragging(false);
      show();
    },
    [dragging, show],
  );

  if (!scrollable) return null;

  const visible = active || dragging;

  return (
    <div
      ref={measureRail}
      data-mini-scrollbar={orientation}
      aria-hidden
      className={cn(
        "pointer-events-none absolute z-10 transition-opacity duration-200",
        vertical ? "inset-y-0.5 right-0.5 w-1.5" : "inset-x-0.5 bottom-0.5 h-1.5",
        // Hover is a desktop-only affordance and costs touch nothing.
        visible ? "opacity-100" : "opacity-0 hover:opacity-60",
        className,
      )}
    >
      <div
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        className={cn(
          // `touch-none` for the reason every scrollbar has it: the drag is
          // ours, and letting the UA start a pan first makes preventDefault a
          // no-op on iOS.
          "absolute touch-none rounded-full bg-muted-foreground/50 transition-colors",
          visible && "pointer-events-auto",
          dragging ? "bg-muted-foreground" : "hover:bg-muted-foreground/80",
          vertical ? "inset-x-0" : "inset-y-0",
        )}
        style={
          vertical ? { top: thumbStartPx, height: thumbPx } : { left: thumbStartPx, width: thumbPx }
        }
      />
    </div>
  );
}
