import { useEffect, useRef, useState } from "react";
import { MessageSquarePlus } from "lucide-react";
import { Button } from "@/components/ui/button";

interface SelectionInfo {
  range: Range;
  start: HTMLElement;
  end: HTMLElement;
  top: number;
  left: number;
}

function codeAt(node: Node) {
  const element = node instanceof Element ? node : node.parentElement;
  return element?.closest<HTMLElement>("code[data-patch-index]");
}

export function DiffSelection({
  children,
  onComment,
}: {
  children: React.ReactNode;
  onComment: (first: number, last: number, text: string) => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState<SelectionInfo | null>(null);
  useEffect(() => {
    function update() {
      const selection = document.getSelection();
      const box = root.current;
      if (!selection?.rangeCount || selection.isCollapsed || !box) {
        setSelected(null);
        return;
      }
      const range = selection.getRangeAt(0);
      const start = codeAt(range.startContainer);
      const end = codeAt(range.endContainer);
      if (!start || !end || !box.contains(start) || !box.contains(end)) {
        setSelected(null);
        return;
      }
      const caret = range.cloneRange();
      caret.collapse(
        selection.focusNode === range.startContainer && selection.focusOffset === range.startOffset,
      );
      const rect = caret.getBoundingClientRect();
      const bounds = box.getBoundingClientRect();
      setSelected({
        range: range.cloneRange(),
        start,
        end,
        left: Math.max(0, Math.min(bounds.width - 106, rect.left - bounds.left)),
        top: Math.max(0, Math.min(bounds.height - 28, rect.bottom - bounds.top + 2)),
      });
    }
    document.addEventListener("selectionchange", update);
    return () => document.removeEventListener("selectionchange", update);
  }, []);
  function begin() {
    if (!selected || !root.current) return;
    const { start, end, range } = selected;
    const first = Number(start.dataset.patchIndex);
    const last = Number(end.dataset.patchIndex);
    const text: string[] = [];
    // Copy code only. Browser selections also span line numbers and gutter buttons.
    for (const code of root.current.querySelectorAll("code[data-patch-index]")) {
      const index = Number((code as HTMLElement).dataset.patchIndex);
      if (index < first || index > last) continue;
      const part = document.createRange();
      part.selectNodeContents(code);
      if (code === start) part.setStart(range.startContainer, range.startOffset);
      if (code === end) part.setEnd(range.endContainer, range.endOffset);
      text.push(part.toString());
    }
    if (!text.join("\n").trim()) return;
    onComment(first, last, text.join("\n"));
    document.getSelection()?.removeAllRanges();
  }
  return (
    <div ref={root} className="relative">
      {children}
      {selected && (
        <Button
          size="sm"
          variant="outline"
          className="absolute z-10 h-7 rounded-full bg-popover px-2.5 shadow-md"
          style={{ left: selected.left, top: selected.top }}
          onMouseDown={(e) => e.preventDefault()}
          onClick={begin}
        >
          <MessageSquarePlus size={14} />
          Comment
        </Button>
      )}
    </div>
  );
}
