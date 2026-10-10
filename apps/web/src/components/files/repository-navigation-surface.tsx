"use client";

import { useEffect, useRef } from "react";

/** File gestures leave native vertical and wide-code scrolling available. */
export function RepositoryNavigationSurface({
  children,
  back,
  forward,
}: {
  children: React.ReactNode;
  back: () => void;
  forward: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const actions = useRef({ back, forward });
  actions.current = { back, forward };

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    let drag: {
      id: number;
      x: number;
      y: number;
      lastX: number;
      axis: "pending" | "horizontal" | "vertical";
    } | null = null;
    let suppressClick = false;
    let clickTimer: ReturnType<typeof setTimeout> | undefined;
    const start = (event: TouchEvent) => {
      drag = null;
      suppressClick = false;
      clearTimeout(clickTimer);
      if (event.touches.length !== 1 || !(event.target instanceof Element))
        return;
      if (event.target.closest("input,textarea,select,[contenteditable=true]"))
        return;
      // Keep native horizontal panning in breadcrumbs, images and wide code.
      for (
        let node: Element | null = event.target;
        node && node !== element;
        node = node.parentElement
      ) {
        const overflow = getComputedStyle(node).overflowX;
        if (
          /auto|scroll/.test(overflow) &&
          node.scrollWidth > node.clientWidth + 1
        )
          return;
      }
      const touch = event.touches[0]!;
      // Browser edge gestures use the viewer's native history entries.
      if (touch.clientX < 24 || touch.clientX > window.innerWidth - 24) return;
      drag = {
        id: touch.identifier,
        x: touch.clientX,
        y: touch.clientY,
        lastX: touch.clientX,
        axis: "pending",
      };
    };
    const move = (event: TouchEvent) => {
      if (!drag) return;
      if (event.touches.length !== 1) {
        drag = null;
        return;
      }
      const touch = Array.from(event.touches).find(
        (touch) => touch.identifier === drag!.id,
      );
      if (!touch) return;
      const dx = touch.clientX - drag.x;
      const dy = touch.clientY - drag.y;
      drag.lastX = touch.clientX;
      if (drag.axis === "pending" && Math.hypot(dx, dy) >= 10) {
        drag.axis =
          Math.abs(dx) > Math.abs(dy) * 1.5 ? "horizontal" : "vertical";
      }
      if (drag.axis === "horizontal" && event.cancelable)
        event.preventDefault();
    };
    const end = (event: TouchEvent) => {
      const current = drag;
      drag = null;
      if (!current || current.axis !== "horizontal") return;
      if (event.cancelable) event.preventDefault();
      suppressClick = true;
      clickTimer = setTimeout(() => {
        suppressClick = false;
      }, 400);
      const touch = Array.from(event.changedTouches).find(
        (touch) => touch.identifier === current.id,
      );
      const dx = (touch?.clientX ?? current.lastX) - current.x;
      if (Math.abs(dx) >= 60) {
        if (dx > 0) actions.current.back();
        else actions.current.forward();
      }
    };
    const cancel = () => {
      drag = null;
    };
    const click = (event: MouseEvent) => {
      if (!suppressClick) return;
      event.preventDefault();
      event.stopPropagation();
      suppressClick = false;
    };
    const options = { capture: true, passive: false } as const;
    element.addEventListener("touchstart", start, options);
    element.addEventListener("touchmove", move, options);
    element.addEventListener("touchend", end, options);
    element.addEventListener("touchcancel", cancel, options);
    element.addEventListener("click", click, true);
    return () => {
      clearTimeout(clickTimer);
      element.removeEventListener("touchstart", start, options);
      element.removeEventListener("touchmove", move, options);
      element.removeEventListener("touchend", end, options);
      element.removeEventListener("touchcancel", cancel, options);
      element.removeEventListener("click", click, true);
    };
  }, []);

  return (
    <div
      ref={ref}
      className="flex min-h-0 flex-1 flex-col"
      data-repository-navigation
    >
      {children}
    </div>
  );
}
