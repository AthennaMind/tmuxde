import { usePaneStore } from "@/features/panes/pane-store";
import { useCommentComposer } from "./comment-context";
import { useEffect, useEffectEvent, useState } from "react";
import { editor as Monaco, KeyCode, KeyMod } from "monaco-editor";
import { MessageSquarePlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CommentComposer } from "./comment-composer";

export function AgentComments({
  path,
  machine,
  editor,
}: {
  path: string;
  machine: string;
  editor: Monaco.IStandaloneCodeEditor;
}) {
  return (
    <CommentComposer
      machine={machine}
      onSend={() => {
        const pos = editor.getPosition();
        if (pos) editor.setPosition(pos);
      }}
    >
      <EditorMarkers path={path} editor={editor} />
    </CommentComposer>
  );
}

function EditorMarkers({ path, editor }: { path: string; editor: Monaco.IStandaloneCodeEditor }) {
  const { comments, open } = useCommentComposer();
  const [anchor, setAnchor] = useState<{ top: number; left: number } | null>(null);
  function begin() {
    const selection = editor.getSelection();
    const range = selection && !selection.isEmpty() ? selection : undefined;
    const snippet = range
      ? (editor.getModel()?.getValueInRange(range).replaceAll("\r\n", "\n") ?? "")
      : "";
    open({
      paneId: usePaneStore.getState().activePaneId ?? undefined,
      id: crypto.randomUUID(),
      path,
      range,
      snippet,
      note: "",
      images: [],
    });
  }
  const openFromEditor = useEffectEvent(begin);
  useEffect(() => {
    const action = editor.addAction({
      id: "tmuxde.agent-comment",
      label: "Add agent comment",
      contextMenuGroupId: "navigation",
      contextMenuOrder: 1,
      keybindings: [KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.KeyM],
      run: () => openFromEditor(),
    });
    function position() {
      const sel = editor.getSelection();
      const pos =
        sel && !sel.isEmpty() ? editor.getScrolledVisiblePosition(sel.getPosition()) : null;
      const { height, width } = editor.getLayoutInfo();
      setAnchor(
        pos && pos.top >= 0 && pos.top < height
          ? {
              left: Math.max(4, Math.min(pos.left, width - 114)),
              top: Math.max(4, Math.min(pos.top + pos.height + 4, height - 32)),
            }
          : null,
      );
    }
    position();
    const listeners = [
      action,
      editor.onDidChangeCursorSelection(position),
      editor.onDidScrollChange(position),
      editor.onDidLayoutChange(position),
    ];
    return () => listeners.forEach((l) => l.dispose());
  }, [editor]);

  const editMarked = useEffectEvent(open);
  useEffect(() => {
    const candidates = comments.filter((c) => c.path === path && c.range);
    let marked = candidates;
    const marks = editor.createDecorationsCollection();
    function update() {
      const model = editor.getModel();
      marked = candidates.filter(
        (c) => model?.getValueInRange(c.range!).replaceAll("\r\n", "\n") === c.snippet,
      );
      marks.set(
        marked.map((c) => ({
          range: c.range!,
          options: {
            inlineClassName: "agent-comment-range",
            linesDecorationsClassName: "agent-comment-gutter",
            hoverMessage: { value: c.note.replace(/[\\`*_{}[\]()#+.!|<>]/g, "\\$&") },
          },
        })),
      );
    }
    update();
    const content = editor.onDidChangeModelContent(update);
    const click = editor.onMouseUp((e) => {
      if (!e.event.leftButton || !e.target.position) return;
      const pos = e.target.position;
      const gutter = e.target.type === Monaco.MouseTargetType.GUTTER_LINE_DECORATIONS;
      if (
        !gutter &&
        (e.target.type !== Monaco.MouseTargetType.CONTENT_TEXT || !editor.getSelection()?.isEmpty())
      )
        return;
      const index = marks
        .getRanges()
        .findIndex((r) =>
          gutter
            ? r.startLineNumber <= pos.lineNumber && pos.lineNumber <= r.endLineNumber
            : r.containsPosition(pos),
        );
      if (index >= 0) editMarked(marked[index]!);
    });
    return () => {
      content.dispose();
      click.dispose();
      marks.clear();
    };
  }, [editor, path, comments]);

  return (
    <>
      {anchor && (
        <Button
          size="sm"
          variant="outline"
          className="absolute z-10 h-7 rounded-full bg-popover px-2.5 shadow-md"
          style={anchor}
          onMouseDown={(e) => e.preventDefault()}
          onClick={begin}
        >
          <MessageSquarePlus size={14} />
          Comment
        </Button>
      )}
    </>
  );
}
