import Editor, { loader } from "@monaco-editor/react";
import type { OnMount, OnChange } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import { useCallback, useRef } from "react";
import { useTerminalStore } from "@/features/terminal/terminal-store";
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

interface MonacoEditorProps {
  content: string;
  language: string;
  readOnly?: boolean;
  onChange?: (value: string) => void;
  onSave?: () => void;
  theme?: "vs-dark" | "light";
  wordWrap?: "on" | "off";
  fontSize?: number;
}

export function MonacoEditor({
  content,
  language,
  readOnly = false,
  onChange,
  onSave,
  theme = "vs-dark",
  wordWrap = "on",
  fontSize: fixedFontSize,
}: MonacoEditorProps) {
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);
  const codeWeight = useTerminalStore((s) => s.codeWeight);
  // Follows the code zoom unless the caller fixes a size.
  const codeZoom = useTerminalStore((s) => s.codeZoom);
  const fontSize = fixedFontSize ?? Math.round(14 * codeZoom);

  const handleMount: OnMount = useCallback(
    (editor, monacoApi) => {
      editorRef.current = editor;

      // Register Ctrl+S / Cmd+S keybinding
      if (onSave) {
        editor.addCommand(monacoApi.KeyMod.CtrlCmd | monacoApi.KeyCode.KeyS, () => {
          onSave();
        });
      }

      // Monaco measures glyphs once. If the web font lands after mount, those
      // widths are the fallback's and the cursor drifts off the text.
      void document.fonts
        .load('400 16px "Cascadia Code"', "W")
        .then(() => monacoApi.editor.remeasureFonts())
        .catch(() => {});

      editor.focus();
    },
    [onSave],
  );

  const handleChange: OnChange = useCallback(
    (value) => {
      onChange?.(value ?? "");
    },
    [onChange],
  );

  return (
    <Editor
      height="100%"
      language={language}
      value={content}
      theme={theme}
      loading={loadingSkeleton}
      onChange={handleChange}
      onMount={handleMount}
      options={{
        readOnly,
        minimap: { enabled: true },
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
