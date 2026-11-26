import { useComments } from "./comment-store";
import { useSessionStore } from "@/features/session/session-store";
import { useAlertStore } from "@/shared/alert-store";
import type { FileTab } from "@/features/workspace/main-tabs-store";
import { useFileDrafts } from "./file-drafts";
import Editor, { loader } from "@monaco-editor/react";
import type { OnMount, OnChange } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import { useCallback, useEffect, useEffectEvent, useLayoutEffect, useState } from "react";
import { useTerminalStore } from "@/features/terminal/terminal-store";
import { applyMonacoTheme, useMonacoTheme } from "./monaco-theme";
import { EditorGitChanges } from "./editor-git-changes";
import { AgentComments } from "./agent-comments";
import { FileLoading } from "./file-loading";
// Before loader.config, so Monaco finds the bundled workers.
import "./monaco-workers";

/** Same face as terminal and repository views. */
const CODE_FONT = '"Cascadia Code", "IBM Plex Mono", monospace';

// Configure @monaco-editor/react to use the locally installed monaco-editor
// instead of fetching from CDN
loader.config({ monaco });

type CodeEditor = Parameters<OnMount>[0];

interface MonacoEditorProps {
  file?: { path: string; machine: string; truncated?: boolean };
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
  file,
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
  }, []);

  useLayoutEffect(() => {
    if (!editor) return;
    // The package creates Monaco in a display:none container. Size and paint
    // it before revealing it instead of waiting for automaticLayout's observer.
    editor.layout();
    editor.render(true);
    // A slow editor mount must not interrupt naming another file in the tree.
    if (!document.querySelector("[data-file-name-input]")) editor.focus();
  }, [editor]);

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
      endLineNumber: position.endLine ?? position.line,
      startColumn: position.column,
      endColumn: position.endColumn,
    };
    if (position.commentId && file) {
      const key = JSON.stringify([file.machine, useSessionStore.getState().activeSessionId]);
      const c = useComments.getState().batches[key]?.find((item) => item.id === position.commentId);
      if (c && editor.getModel()?.getValueInRange(range).replaceAll("\r\n", "\n") !== c.snippet) {
        useAlertStore
          .getState()
          .push("info", "File changed. Review the original selection in the batch.");
        navigated();
        return;
      }
    }
    editor.setSelection(range);
    editor.revealRangeInCenter(range);
    editor.focus();
    navigated();
  }, [editor, position, file]);

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
    <div className="flex h-full flex-col">
      <div className="relative min-h-0 flex-1">
        {file && editor && <AgentComments {...file} editor={editor} />}
        {file && !file.truncated && editor && (
          <EditorGitChanges
            key={JSON.stringify([file.machine, file.path])}
            {...file}
            content={content}
            editor={editor}
          />
        )}
        {!editor && <FileLoading />}
        <div className="absolute inset-0" style={{ visibility: editor ? "visible" : "hidden" }}>
          {/* Monaco caches line widths at creation. Keep its mount measurable
              while the wrapper hides it during loading. */}
          <Editor
            className="absolute inset-0 block!"
            height="100%"
            path={modelPath}
            keepCurrentModel={!!modelPath}
            saveViewState
            language={language}
            defaultValue={content}
            theme={theme}
            beforeMount={applyMonacoTheme}
            loading={null}
            onChange={handleChange}
            onMount={handleMount}
            options={{
              // Retained models must not restore pending occurrence requests.
              occurrencesHighlight: modelPath ? "off" : "singleFile",
              readOnly,
              minimap: { enabled: false },
              lineNumbers: "on",
              ...(file && { glyphMargin: true }),
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
        </div>
      </div>
    </div>
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
