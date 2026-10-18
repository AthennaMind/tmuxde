import { useSyncExternalStore } from "react";

/**
 * Media query hook that re-evaluates on real viewport changes (window
 * resize, orientation change, devtools toggle) but ignores pinch-zoom, which
 * changes the CSS viewport width without a real layout shift.
 *
 * The zoom guard checks `visualViewport.scale ≈ 1`. While the user is
 * pinch-zoomed, matchMedia "change" events are ignored. Otherwise the
 * layout-critical mobile/desktop switch could flip-flop, which would destroy
 * and rebuild the component tree and kill xterm.
 */
export function useStableMediaQuery(query: string): boolean {
  const store = stableQuery(query);
  return useSyncExternalStore(store.subscribe, store.getSnapshot, () => false);
}

interface StableQuery {
  subscribe: (notify: () => void) => () => void;
  getSnapshot: () => boolean;
}

/**
 * One store per query, shared by every component that asks it. The store
 * holds the accepted answer, which only real viewport changes move. A
 * component that mounts during a pinch therefore agrees with the layout
 * around it.
 */
const queries = new Map<string, StableQuery>();

function isPinchZoomed(): boolean {
  const scale = window.visualViewport?.scale ?? 1;
  return Math.abs(scale - 1) > 0.05;
}

function stableQuery(query: string): StableQuery {
  const known = queries.get(query);
  if (known) return known;

  const media = window.matchMedia(query);
  const listeners = new Set<() => void>();
  let accepted = media.matches;

  const accept = () => {
    if (accepted === media.matches) return;
    accepted = media.matches;
    for (const notify of listeners) notify();
  };
  // Fires on real resizes and on zoom-driven viewport changes alike, so it
  // gates on the zoom scale.
  const onMediaChange = () => {
    if (!isPinchZoomed()) accept();
  };
  // Orientation change as fallback for some mobile browsers. The query
  // settles shortly after the event.
  const onOrientationChange = () => {
    setTimeout(accept, 100);
  };

  const store: StableQuery = {
    subscribe(notify) {
      if (listeners.size === 0) {
        // Nobody listened, so changes since then went unseen.
        accepted = media.matches;
        media.addEventListener("change", onMediaChange);
        window.addEventListener("orientationchange", onOrientationChange);
        screen.orientation?.addEventListener("change", onOrientationChange);
      }
      listeners.add(notify);
      return () => {
        listeners.delete(notify);
        if (listeners.size > 0) return;
        media.removeEventListener("change", onMediaChange);
        window.removeEventListener("orientationchange", onOrientationChange);
        screen.orientation?.removeEventListener("change", onOrientationChange);
      };
    },
    // A first render before any subscription reads the live answer, as a
    // fresh mount always did.
    getSnapshot: () => (listeners.size > 0 ? accepted : media.matches),
  };
  queries.set(query, store);
  return store;
}
