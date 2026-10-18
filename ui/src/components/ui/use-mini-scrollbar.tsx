import { useState } from "react";
import { MiniScrollbar, type MiniScrollbarOrientation } from "./mini-scrollbar";

/**
 * `MiniScrollbar` plus the ref that feeds it.
 *
 * Two lines at a call site instead of a `useState` dance each time: spread
 * `ref` onto the scrolling element, render `scrollbar` inside a positioned
 * ancestor of it.
 */
export function useMiniScrollbar(orientation: MiniScrollbarOrientation = "vertical") {
  const [node, setNode] = useState<HTMLElement | null>(null);
  return {
    ref: setNode,
    scrollbar: <MiniScrollbar target={node} orientation={orientation} />,
  };
}
