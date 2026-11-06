import type { FileTab } from "@/features/workspace/main-tabs-store";
import { useFileDrafts } from "./file-drafts";
import Editor, { loader } from "@monaco-editor/react";
import type { OnMount, OnChange } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import { useCallback, useEffect, useEffectEvent, useState } from "react";
import { useTerminalStore } from "@/features/terminal/terminal-store";
import { applyMonacoTheme, useMonacoTheme } from "./monaco-theme";
// Before loader.config, so Monaco finds the bundled workers.
import "./monaco-workers";

/** Same face as terminal and repository views. */
const CODE_FONT = '"Cascadia Code", "IBM Plex Mono", monospace';

// Configure @monaco-editor/react to use the locally installed monaco-editor
// instead of fetching from CDN
loader.config({ monaco });

// Shows while Monaco starts. This module is itself lazy loaded, so the editor
// package needs no lazy import of its own.
const loadingSkeleton = (
  <div className="flex-1 space-y-2 p-4">
    {Array.from({ length: 12 }).map((_, i) => (
      <div
        key={i}
        className="h-4 animate-pulse rounded bg-muted"
        style={{ width: `${40 + Math.random() * 50}%` }}
      />
    ))}
  </div>
);

type CodeEditor = Parameters<OnMount>[0];

interface MonacoEditorProps {
  /**
   * The text to show. Monaco takes it at mount, and again whenever
   * `revision` changes. Edits in the editor do not come back through it.
   */
  content: string;
  /** Retain model and view state while a file tab is inactive. */
  modelPath?: string;
  /**
   * Changes when `content` is replaced from outside, as by a load. Typing
   * leaves it alone. Defaults to `content`, so every new text counts.
   */
  revision?: unknown;
  language: string;
  readOnly?: boolean;
  onChange?: (value: string) => void;
  onSave?: () => void;
  wordWrap?: "on" | "off";
  fontSize?: number;
  position?: FileTab["position"];
  onNavigate?: () => void;
}

export function MonacoEditor({
  content,
  modelPath,
  revision = content,
  language,
  readOnly = false,
  onChange,
  onSave,
  wordWrap = "on",
  fontSize: fixedFontSize,
  position,
  onNavigate,
}: MonacoEditorProps) {
  const theme = useMonacoTheme();
  // Set once Monaco has mounted. The effects below reach it through this.
  const [editor, setEditor] = useState<CodeEditor | null>(null);
  const codeWeight = useTerminalStore((s) => s.codeWeight);
  // Follows the code zoom unless the caller fixes a size.
  const codeZoom = useTerminalStore((s) => s.codeZoom);
  const fontSize = fixedFontSize ?? Math.round(14 * codeZoom);

  // The package calls the `onMount` of its first render, once. It only
  // hands the editor over. Everything that reads props runs in effects.
  const handleMount: OnMount = useCallback((mounted, monacoApi) => {
    setEditor(mounted);
    // Monaco measures glyphs once. If the web font lands after mount, those
    // widths are the fallback's and the cursor drifts off the text.
    void document.fonts
      .load('400 16px "Cascadia Code"', "W")
      .then(() => monacoApi.editor.remeasureFonts())
      .catch(() => {});
    // A slow editor mount must not interrupt naming another file in the tree.
    if (!document.querySelector("[data-file-name-input]")) mounted.focus();
  }, []);

  /*
   * Monaco owns the text while someone types. A controlled `value` raced
   * the keyboard: the package's update effect could still hold the text of
   * the render before the last key and write it back over that key. The
   * text goes in at mount through `defaultValue`, and again for each new
   * revision. An edit keeps the undo history. A read-only editor refuses
   * edits, so it gets the text set.
   */
  const showContent = useEffectEvent((target: CodeEditor) => {
    if (target.getValue() === content) return;
    if (readOnly) {
      target.setValue(content);
      return;
    }
    const model = target.getModel();
    if (!model) return;
    target.executeEdits("", [
      { range: model.getFullModelRange(), text: content, forceMoveMarkers: true },
    ]);
    target.pushUndoStop();
  });
  useEffect(() => {
    if (editor) showContent(editor);
  }, [editor, revision]);

  const navigated = useEffectEvent(() => onNavigate?.());
  useEffect(() => {
    if (!editor || !position) return;
    const range = {
      startLineNumber: position.line,
      endLineNumber: position.line,
      startColumn: position.column,
      endColumn: position.endColumn,
    };
    editor.setSelection(range);
    editor.revealRangeInCenter(range);
    editor.focus();
    navigated();
  }, [editor, position]);

  // Ctrl+S / Cmd+S runs the `onSave` of the latest render.
  const save = useEffectEvent(() => onSave?.());
  const canSave = !!onSave;
  useEffect(() => {
    if (!editor || !canSave) return;
    const action = editor.addAction({
      id: "tmuxde.save",
      label: "Save",
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS],
      run: () => save(),
    });
    return () => action.dispose();
  }, [editor, canSave]);

  const handleChange: OnChange = useCallback(
    (value) => {
      onChange?.(value ?? "");
    },
    [onChange],
  );

  return (
    <Editor
      height="100%"
      path={modelPath}
      keepCurrentModel={!!modelPath}
      saveViewState
      language={language}
      defaultValue={content}
      theme={theme}
      beforeMount={applyMonacoTheme}
      loading={loadingSkeleton}
      onChange={handleChange}
      onMount={handleMount}
      options={{
        // Retained models must not restore pending occurrence requests.
        occurrencesHighlight: modelPath ? "off" : "singleFile",
        readOnly,
        minimap: { enabled: false },
        lineNumbers: "on",
        wordWrap,
        fontSize,
        fontFamily: CODE_FONT,
        fontWeight: String(codeWeight),
        fontLigatures: true,
        scrollBeyondLastLine: false,
        automaticLayout: true,
        tabSize: 2,
        renderWhitespace: "selection",
        bracketPairColorization: { enabled: true },
        padding: { top: 8 },
      }}
    />
  );
}

useFileDrafts.subscribe((state, previous) => {
  const retained = new Set(Object.values(state.drafts).map((draft) => draft.modelKey));
  for (const draft of Object.values(previous.drafts)) {
    if (!retained.has(draft.modelKey))
      monaco.editor
        .getModel(monaco.Uri.parse(`tmuxde-file://draft/${encodeURIComponent(draft.modelKey)}`))
        ?.dispose();
  }
});
