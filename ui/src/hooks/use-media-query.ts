import { useEffect, useState } from "react";

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.matchMedia(query).matches;
  });

  useEffect(() => {
    const media = window.matchMedia(query);
    if (media.matches !== matches) {
      setMatches(media.matches);
    }
    const listener = () => setMatches(media.matches);
    media.addEventListener("change", listener);
    return () => media.removeEventListener("change", listener);
  }, [matches, query]);

  return matches;
}

/**
 * A stable variant of useMediaQuery that re-evaluates on real viewport
 * changes (window resize, orientation change, devtools toggle) but ignores
 * pinch-zoom which changes the CSS viewport width without a real layout shift.
 *
 * The zoom guard checks `visualViewport.scale ≈ 1` — when the user is
 * pinch-zoomed, matchMedia "change" events are suppressed to prevent
 * layout-critical mobile/desktop switches from flip-flopping (which would
 * destroy and rebuild the component tree, killing xterm).
 */
export function useStableMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.matchMedia(query).matches;
  });

  useEffect(() => {
    const media = window.matchMedia(query);

    // Sync initial value
    setMatches(media.matches);

    const isZoomed = () => {
      const scale = window.visualViewport?.scale ?? 1;
      return Math.abs(scale - 1) > 0.05;
    };

    // matchMedia change listener — fires on real resize AND zoom-driven
    // viewport changes, so we gate on zoom scale
    const handleMediaChange = () => {
      if (isZoomed()) return; // pinch-zoom, ignore
      setMatches(media.matches);
    };

    media.addEventListener("change", handleMediaChange);

    // Orientation change as fallback (some mobile browsers)
    const handleOrientationChange = () => {
      setTimeout(() => {
        setMatches(media.matches);
      }, 100);
    };

    window.addEventListener("orientationchange", handleOrientationChange);
    screen.orientation?.addEventListener("change", handleOrientationChange);

    return () => {
      media.removeEventListener("change", handleMediaChange);
      window.removeEventListener("orientationchange", handleOrientationChange);
      screen.orientation?.removeEventListener("change", handleOrientationChange);
    };
  }, [query]);

  return matches;
}
