const NON_TEXT_INPUTS = new Set([
  "button",
  "checkbox",
  "color",
  "file",
  "hidden",
  "image",
  "radio",
  "range",
  "reset",
  "submit",
]);

/** Keep native editing and content actions. App menus handle their own events first. */
export function installContextMenuPolicy(document: Document): () => void {
  const onContextMenu = (event: MouseEvent) => {
    if (event.defaultPrevented) return;
    const target = event
      .composedPath()
      .find((node): node is HTMLElement => node instanceof HTMLElement);
    if (target) {
      const field = target.closest("input, textarea");
      if (
        field instanceof HTMLTextAreaElement ||
        (field instanceof HTMLInputElement &&
          !field.disabled &&
          !NON_TEXT_INPUTS.has(field.type)) ||
        target.isContentEditable ||
        target.closest("a[href], area[href], img, video, audio, .xterm, [data-native-context-menu]")
      )
        return;
      const selection = document.getSelection();
      if (selection && !selection.isCollapsed && selection.containsNode(target, true)) return;
    }
    event.preventDefault();
  };

  // Bubble after component handlers, including menus rendered through portals.
  document.addEventListener("contextmenu", onContextMenu);
  return () => document.removeEventListener("contextmenu", onContextMenu);
}
