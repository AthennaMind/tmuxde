import { useEffect, useRef } from "react";
import { editor as Monaco, Range } from "monaco-editor";
import { findOpenHunk, hunkBlocks, hunkKind, type FileHunk } from "./file-hunk";
import { useFileHunks } from "./use-file-hunks";

type CodeEditor = Monaco.IStandaloneCodeEditor;

function preview(editor: CodeEditor, hunk: FileHunk) {
  const node = document.createElement("div");
  node.className = "file-diff-preview";
  node.setAttribute("role", "region");
  node.setAttribute("aria-label", "Inline file change");
  node.tabIndex = 0;
  editor.applyFontInfo(node);
  let rows = 0;
  for (const block of hunkBlocks(hunk)) {
    const pre = document.createElement("pre");
    pre.className = block.className;
    pre.textContent = block.text;
    rows += block.rows;
    node.append(pre);
  }
  return { domNode: node, heightInLines: Math.min(rows + 1, 12) };
}

function mountGitChanges(editor: CodeEditor) {
  const marks = editor.createDecorationsCollection();
  let hunks: FileHunk[] = [];
  let expanded: { hunk: FileHunk; line: number; zone: string } | undefined;

  function close() {
    const previous = expanded;
    if (previous) editor.changeViewZones((zones) => zones.removeZone(previous.zone));
    expanded = undefined;
  }

  function show(hunk: FileHunk, line: number) {
    close();
    editor.changeViewZones((zones) => {
      const zone = zones.addZone({
        afterLineNumber: hunk.beforeFirst ? 0 : line,
        ...preview(editor, hunk),
      });
      expanded = { hunk, line, zone };
    });
  }

  function lane(hunk: FileHunk) {
    return hunk.beforeFirst ? Monaco.GlyphMarginLane.Left : Monaco.GlyphMarginLane.Center;
  }

  function update(next: FileHunk[]) {
    if (expanded) {
      const tracked = marks.getRange(hunks.indexOf(expanded.hunk));
      const offset = expanded.line - expanded.hunk.start;
      const anchor = tracked
        ? Math.min(tracked.endLineNumber, tracked.startLineNumber + offset)
        : expanded.line;
      const match = findOpenHunk(next, expanded.hunk, anchor);
      if (!match) close();
      else {
        const line = Math.min(match.end, Math.max(match.start, anchor));
        if (
          line !== expanded.line ||
          match.added !== expanded.hunk.added ||
          match.removed !== expanded.hunk.removed ||
          match.beforeFirst !== expanded.hunk.beforeFirst
        ) {
          show(match, line);
        } else {
          expanded.hunk = match;
        }
      }
    }
    hunks = next;
    marks.set(
      hunks.map((hunk) => ({
        range: new Range(hunk.start, 1, hunk.end, 1),
        options: {
          stickiness: Monaco.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
          glyphMargin: { position: lane(hunk) },
          glyphMarginClassName: "file-diff-dot file-diff-" + hunkKind(hunk),
          glyphMarginHoverMessage: { value: "Show " + hunkKind(hunk) + " lines" },
        },
      })),
    );
  }

  function atLine(line: number) {
    return hunks.filter((_, index) => {
      const range = marks.getRange(index);
      return range && range.startLineNumber <= line && line <= range.endLineNumber;
    });
  }

  const click = editor.onMouseDown(({ event, target }) => {
    if (
      !event.leftButton ||
      target.type !== Monaco.MouseTargetType.GUTTER_GLYPH_MARGIN ||
      target.detail.isAfterLines
    )
      return;
    const line = target.position.lineNumber;
    const hunk = atLine(line).find((h) => lane(h) === target.detail.glyphMarginLane);
    if (!hunk) return;
    if (hunk === expanded?.hunk) close();
    else show(hunk, line);
  });

  const action = editor.addAction({
    id: "tmuxde.toggle-file-change",
    label: "Toggle inline file change",
    run: () => {
      const line = editor.getPosition()?.lineNumber ?? 1;
      const candidates = atLine(line);
      const index = expanded ? candidates.indexOf(expanded.hunk) : -1;
      const next = candidates[index + 1];
      if (next) show(next, line);
      else close();
    },
  });

  return {
    update,
    dispose() {
      click.dispose();
      action.dispose();
      marks.clear();
      close();
    },
  };
}

export function EditorGitChanges({
  editor,
  path,
  machine,
  content,
}: {
  editor: CodeEditor;
  path: string;
  machine: string;
  content: string;
}) {
  const hunks = useFileHunks(machine, path, content);
  const controller = useRef<ReturnType<typeof mountGitChanges> | null>(null);
  useEffect(() => {
    const mounted = mountGitChanges(editor);
    controller.current = mounted;
    return () => {
      mounted.dispose();
      controller.current = null;
    };
  }, [editor]);
  useEffect(() => {
    if (hunks) controller.current?.update(hunks);
  }, [editor, hunks]);
  return null;
}
