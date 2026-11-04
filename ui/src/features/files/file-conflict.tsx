import { useEffect, useRef } from "react";
import * as monaco from "monaco-editor";
import { useTerminalStore } from "@/features/terminal/terminal-store";
import { getMonacoLanguage } from "./file-utils";
import { applyMonacoTheme, useMonacoTheme } from "./monaco-theme";
import "./monaco-workers";

export function FileConflict({ path, disk, draft }: { path: string; disk: string; draft: string }) {
  useMonacoTheme();
  const container = useRef<HTMLDivElement>(null);
  const zoom = useTerminalStore((state) => state.codeZoom);
  const weight = useTerminalStore((state) => state.codeWeight);

  useEffect(() => {
    if (!container.current) return;
    const language = getMonacoLanguage(path);
    const original = monaco.editor.createModel(disk, language);
    const modified = monaco.editor.createModel(draft, language);
    const editor = monaco.editor.createDiffEditor(container.current, {
      theme: applyMonacoTheme(),
      minimap: { enabled: false },
      readOnly: true,
      occurrencesHighlight: "off",
      automaticLayout: true,
      renderSideBySide: true,
      scrollBeyondLastLine: false,
      fontFamily: '"Cascadia Code", "IBM Plex Mono", monospace',
      fontSize: Math.round(14 * zoom),
      fontWeight: String(weight),
    });
    const viewModel = editor.createViewModel({ original, modified });
    editor.setModel(viewModel);
    return () => {
      // Detach now, then release models after the worker finishes reading them.
      editor.setModel(null);
      editor.dispose();
      void viewModel.waitForDiff().finally(() => {
        viewModel.dispose();
        original.dispose();
        modified.dispose();
      });
    };
  }, [path, disk, draft, zoom, weight]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex justify-between border-b px-3 py-2 text-xs text-muted-foreground">
        <span>Current disk version</span>
        <span>Your edits</span>
      </div>
      <div ref={container} className="min-h-0 flex-1" />
    </div>
  );
}
