import { useEffect, useRef, useState, type DragEvent, type KeyboardEvent } from "react";
import { moveTabInOrder } from "./main-tabs-store";

type DropTarget = { id: string; side: "before" | "after" };

/** Native dragging keeps clicks and Escape under browser control. */
export function useTabReorder(order: string[], setOrder: (order: string[]) => void) {
  const nav = useRef<HTMLElement>(null);
  const source = useRef<string | null>(null);
  const pointer = useRef<{ x: number; y: number } | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [target, setTarget] = useState<DropTarget | null>(null);
  const [announcement, setAnnouncement] = useState("");

  function targetAt(x: number): DropTarget | null {
    const items = nav.current?.querySelectorAll<HTMLElement>("[data-view-id]");
    if (!items?.length) return null;
    for (const item of items) {
      const rect = item.getBoundingClientRect();
      if (x < rect.left + rect.width / 2) {
        return { id: item.dataset.viewId!, side: "before" };
      }
    }
    return { id: items[items.length - 1]!.dataset.viewId!, side: "after" };
  }

  function finish() {
    source.current = null;
    pointer.current = null;
    setDragging(null);
    setTarget(null);
  }

  function dragOver(event: DragEvent<HTMLElement>) {
    if (!source.current) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    pointer.current = { x: event.clientX, y: event.clientY };
    setTarget(targetAt(event.clientX));
  }

  function move(id: string, destination: DropTarget) {
    const next = moveTabInOrder(order, id, destination.id, destination.side);
    if (next.every((item, index) => item === order[index])) return;
    setOrder(next);
    setAnnouncement(`Tab moved to position ${next.indexOf(id) + 1} of ${next.length}.`);
    requestAnimationFrame(() => {
      const item = Array.from(
        nav.current?.querySelectorAll<HTMLElement>("[data-view-id]") ?? [],
      ).find((element) => element.dataset.viewId === id);
      item?.querySelector<HTMLButtonElement>("[data-view-handle]")?.focus({ preventScroll: true });
      item?.scrollIntoView({ block: "nearest", inline: "nearest" });
    });
  }

  useEffect(() => {
    if (!dragging) return;
    let frame: number;
    // Keep scrolling at either edge even when the pointer stops moving.
    function scroll() {
      const element = nav.current;
      const point = pointer.current;
      if (element && point) {
        const rect = element.getBoundingClientRect();
        if (
          point.y >= rect.top &&
          point.y <= rect.bottom &&
          point.x >= rect.left &&
          point.x <= rect.right
        ) {
          const delta = point.x < rect.left + 36 ? -8 : point.x > rect.right - 36 ? 8 : 0;
          if (delta) {
            element.scrollLeft += delta;
            setTarget(targetAt(point.x));
          }
        }
      }
      frame = requestAnimationFrame(scroll);
    }
    frame = requestAnimationFrame(scroll);
    return () => cancelAnimationFrame(frame);
  }, [dragging]);

  return {
    dragging,
    target,
    announcement,
    navProps: {
      ref: nav,
      onDragStart(event: DragEvent<HTMLElement>) {
        const handle = (event.target as HTMLElement).closest("[data-view-handle]");
        const id = handle?.closest<HTMLElement>("[data-view-id]")?.dataset.viewId;
        if (!id) {
          event.preventDefault();
          return;
        }
        source.current = id;
        setDragging(id);
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", id);
      },
      onDragEnter: dragOver,
      onDragOver: dragOver,
      onDragLeave(event: DragEvent<HTMLElement>) {
        if (
          event.relatedTarget instanceof Node &&
          event.currentTarget.contains(event.relatedTarget)
        )
          return;
        pointer.current = null;
        setTarget(null);
      },
      onDrop(event: DragEvent<HTMLElement>) {
        if (!source.current) return;
        event.preventDefault();
        const destination = targetAt(event.clientX);
        if (destination) move(source.current, destination);
        finish();
      },
      onDragEnd: finish,
      onKeyDown(event: KeyboardEvent<HTMLElement>) {
        if (
          !event.altKey ||
          event.ctrlKey ||
          event.metaKey ||
          event.shiftKey ||
          (event.key !== "ArrowLeft" && event.key !== "ArrowRight")
        )
          return;
        const handle = (event.target as HTMLElement).closest("[data-view-handle]");
        const id = handle?.closest<HTMLElement>("[data-view-id]")?.dataset.viewId;
        if (!id) return;
        event.preventDefault();
        event.stopPropagation();
        const offset = event.key === "ArrowLeft" ? -1 : 1;
        const neighbor = order[order.indexOf(id) + offset];
        if (neighbor) move(id, { id: neighbor, side: offset < 0 ? "before" : "after" });
      },
    },
  };
}
