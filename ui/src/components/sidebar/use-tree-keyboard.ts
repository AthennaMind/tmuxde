import { useCallback, useRef } from "react";

/**
 * Arrow keys, Home and End move focus between rows of one tree.
 *
 * A row that handles the key itself calls `preventDefault`, and the tree
 * leaves it alone. The pane grid does that to move between its cells.
 */
export function useTreeKeyboard() {
  const ref = useRef<HTMLDivElement>(null);
  const onKeyDown = useCallback((event: React.KeyboardEvent) => {
    if (event.defaultPrevented) return;
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const target = event.target as HTMLElement;
    if (!target.dataset.treeRow || !ref.current) return;
    const rows = Array.from(ref.current.querySelectorAll<HTMLElement>("[data-tree-row]"));
    const index = rows.indexOf(target);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? rows.length - 1
          : index + (event.key === "ArrowDown" ? 1 : -1);
    const row = rows[Math.max(0, Math.min(rows.length - 1, next))];
    if (!row) return;
    event.preventDefault();
    row.focus();
  }, []);
  return { ref, onKeyDown };
}
