// Monaco language workers, bundled by Vite through ?worker imports. Monaco
// asks MonacoEnvironment.getWorker before its own new URL fallback, which a
// bundle cannot resolve. Imported by the editor module only, so the workers
// stay out of the main chunk.
/* oxlint-disable import/default -- Vite ?worker modules export a default constructor; oxlint reads the raw Monaco file instead. */
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker.js?worker";
import CssWorker from "monaco-editor/esm/vs/language/css/css.worker.js?worker";
import HtmlWorker from "monaco-editor/esm/vs/language/html/html.worker.js?worker";
import JsonWorker from "monaco-editor/esm/vs/language/json/json.worker.js?worker";
import TsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker.js?worker";
/* oxlint-enable import/default */

self.MonacoEnvironment = {
  getWorker(_workerId: string, label: string) {
    switch (label) {
      case "json":
        return new JsonWorker();
      case "css":
      case "scss":
      case "less":
        return new CssWorker();
      case "html":
      case "handlebars":
      case "razor":
        return new HtmlWorker();
      case "typescript":
      case "javascript":
        return new TsWorker();
      default:
        return new EditorWorker();
    }
  },
};
