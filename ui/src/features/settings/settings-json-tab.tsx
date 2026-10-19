import { useCallback, useDeferredValue, useEffect, useId, useMemo, useRef, useState } from "react";
import * as monaco from "monaco-editor";
import { CircleAlert, Save, TriangleAlert } from "lucide-react";
import type { UserDocumentName } from "@/protocol";
import { Button } from "@/components/ui/button";
import { MonacoEditor } from "@/features/files/monaco-editor";
import { currentPlatform } from "@/features/keybindings/platform";
import { chordLabel } from "@/features/keybindings/shortcut-label";
import { jsonSettingsTabLabel } from "@/features/workspace/main-tabs-store";
import { useTheme } from "@/shared/use-theme";
import { cn } from "@/shared/utils";
import { checkUserDocument } from "./settings-import";
import {
  draftAfterSave,
  nextDraft,
  setJsonDraft,
  useJsonDraftsStore,
} from "./settings-json-drafts";
import { foreignSchemas, modelPattern, schemaAssociations } from "./user-document-schemas";
import { useUserDocumentsStore } from "./user-documents-store";

/**
 * A hub user document as JSON in Monaco, in a main tab.
 *
 * The draft lives in `settings-json-drafts`, so it survives a tab switch.
 * The editor shows the server text until the first edit. When the server
 * text moves on under a draft, as after a save in another browser or a
 * refused save here, a banner offers to reload or to overwrite.
 */

const DESCRIPTIONS: Record<UserDocumentName, string> = {
  settings:
    "Synced through the server. Terminal font size, file and diff text size and GPU rendering stay on each device and are not in this file.",
  keybindings:
    "Changes to the default shortcuts, synced through the server. Later entries win. A command with a leading - removes a default.",
};

/** Model patterns of open settings editors, and the document each shows. */
const boundModels = new Map<string, UserDocumentName>();

/**
 * Point the JSON language at the schemas of the open settings editors.
 * Schemas other code registered stay. The hub takes strict JSON, so
 * comments and trailing commas are errors.
 */
function applySchemas(): void {
  const defaults = monaco.json.jsonDefaults;
  const options = defaults.diagnosticsOptions;
  defaults.setDiagnosticsOptions({
    ...options,
    validate: true,
    allowComments: false,
    enableSchemaRequest: false,
    schemas: [...foreignSchemas(options.schemas), ...schemaAssociations(boundModels)],
  });
}

/**
 * Give the editor inside `host` the schema of `name`.
 *
 * `MonacoEditor` takes no model path, so the model has a generated URI. The
 * editor is found by its container instead, and its model URI goes into the
 * schema's `fileMatch`.
 */
function useDocumentSchema(host: React.RefObject<HTMLDivElement | null>, name: UserDocumentName) {
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    let pattern: string | null = null;
    const bind = (model: monaco.editor.ITextModel | null) => {
      if (pattern) boundModels.delete(pattern);
      pattern = model ? modelPattern(model.uri.toString(true)) : null;
      if (pattern) boundModels.set(pattern, name);
      applySchemas();
    };
    const listeners: monaco.IDisposable[] = [];
    const watch = (editor: monaco.editor.ICodeEditor) => {
      if (!element.contains(editor.getContainerDomNode())) return;
      bind(editor.getModel());
      // The model arrives after the editor is created.
      listeners.push(editor.onDidChangeModel(() => bind(editor.getModel())));
    };
    for (const editor of monaco.editor.getEditors()) watch(editor);
    listeners.push(monaco.editor.onDidCreateEditor(watch));
    return () => {
      for (const listener of listeners) listener.dispose();
      if (pattern) {
        boundModels.delete(pattern);
        applySchemas();
      }
    };
  }, [host, name]);
}

interface Notice {
  tone: "info" | "error";
  text: string;
}

export function SettingsJsonTab({
  name,
  className,
}: {
  name: UserDocumentName;
  className?: string;
}) {
  const doc = useUserDocumentsStore((s) => s.documents[name]);
  const draft = useJsonDraftsStore((s) => s.drafts[name]);
  const { resolvedTheme } = useTheme();
  const hostRef = useRef<HTMLDivElement>(null);
  useDocumentSchema(hostRef, name);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const problemsId = useId();
  const label = jsonSettingsTabLabel(name);
  const platform = currentPlatform();

  // A fresh server copy each time the tab opens.
  useEffect(() => {
    void useUserDocumentsStore.getState().load(name);
  }, [name]);

  const dirty = draft !== undefined && draft.text !== doc.text;
  const shown = dirty ? draft.text : doc.text;
  // The server text moved on since the draft began, or a save was refused.
  const conflict = (dirty && draft.base !== doc.text) || doc.rejectedText !== null;
  const overwriteText = dirty ? draft.text : (doc.rejectedText ?? doc.text);
  // Before the first load the text is a placeholder. Edits on it would be
  // edits of nothing.
  const ready = doc.etag !== null || doc.status === "error";
  // Typing leaves the revision alone. A new server text under a clean
  // editor changes it, and Monaco takes the text in.
  const revision = dirty ? "draft" : `server:${doc.text}`;

  const checked = useDeferredValue(shown);
  const check = useMemo(() => checkUserDocument(name, checked), [name, checked]);

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const handleChange = useCallback(
    (value: string) => {
      const stored = useUserDocumentsStore.getState().documents[name].text;
      setJsonDraft(name, nextDraft(useJsonDraftsStore.getState().drafts[name], value, stored));
      setNotice(null);
    },
    [name],
  );

  async function save(force: boolean) {
    // Before the first load the text is a placeholder, never worth a save.
    if (saving || !ready) return;
    if (conflict && !force) {
      setNotice({ tone: "error", text: "Not saved. Reload or overwrite first." });
      return;
    }
    const text = force ? overwriteText : shown;
    if (!checkUserDocument(name, text).valid) {
      setNotice({ tone: "error", text: "Not saved. Fix the errors under the editor first." });
      return;
    }
    setSaving(true);
    setNotice(null);
    const outcome = await useUserDocumentsStore.getState().save(name, text);
    setSaving(false);
    if (outcome === "saved" || outcome === "unchanged") {
      setJsonDraft(name, draftAfterSave(useJsonDraftsStore.getState().drafts[name], text));
      if (force) useUserDocumentsStore.getState().dismissConflict(name);
      setNotice({ tone: "info", text: outcome === "saved" ? "Saved" : "No changes to save" });
      return;
    }
    // A refused save shows the conflict banner instead.
    if (outcome === "conflict") return;
    const reason = useUserDocumentsStore.getState().documents[name].lastError;
    setNotice({
      tone: "error",
      text: reason
        ? `Unable to save. ${reason}`
        : "Unable to save. Check your connection and try again.",
    });
  }

  function reload() {
    setJsonDraft(name, null);
    useUserDocumentsStore.getState().dismissConflict(name);
    setNotice(null);
  }

  const status = saving
    ? "Saving…"
    : notice
      ? notice.text
      : dirty
        ? "Unsaved changes"
        : doc.status === "error" && doc.lastError
          ? `Not synced. ${doc.lastError}`
          : "";

  return (
    <div
      className={cn("flex flex-col bg-background", className)}
      onKeyDown={(event) => {
        // Ctrl or Cmd with S outside the editor too, so the browser never
        // opens its save page dialog here. Monaco handles its own.
        const mod = platform === "mac" ? event.metaKey : event.ctrlKey;
        if (!mod || event.altKey || event.shiftKey || event.defaultPrevented) return;
        if (event.code !== "KeyS" && event.key.toLowerCase() !== "s") return;
        event.preventDefault();
        void save(false);
      }}
    >
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b px-4 py-2.5">
        <div className="min-w-0 flex-1 basis-64">
          <h1 className="truncate font-mono text-sm font-semibold text-foreground">{label}</h1>
          <p className="text-[13px] leading-5 text-muted-foreground text-pretty">
            {DESCRIPTIONS[name]}
          </p>
        </div>
        <div className="flex items-center">
          {/* Stays rendered for announcements. Takes no space while empty. */}
          <p
            role="status"
            className={cn(
              "me-3 text-[13px] leading-5 whitespace-nowrap empty:me-0",
              notice?.tone === "error" ? "text-destructive" : "text-muted-foreground",
            )}
          >
            {status}
          </p>
          <Button
            size="sm"
            className="pointer-coarse:h-11"
            disabled={saving || !ready}
            title={`Save, ${chordLabel("mod+s", platform)}`}
            aria-keyshortcuts={platform === "mac" ? "Meta+S" : "Control+S"}
            onClick={() => void save(false)}
          >
            <Save aria-hidden />
            Save
          </Button>
        </div>
      </header>

      {conflict && (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-warning/40 bg-warning/10 px-4 py-2"
        >
          <TriangleAlert className="size-4 shrink-0 text-warning" aria-hidden />
          <p className="min-w-0 flex-1 basis-64 text-[13px] leading-5 text-foreground text-pretty">
            {label} changed in another browser. Reload to see that version, or overwrite it with
            yours.
          </p>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" className="pointer-coarse:h-11" onClick={reload}>
              Reload
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="pointer-coarse:h-11"
              disabled={saving}
              onClick={() => void save(true)}
            >
              Overwrite
            </Button>
          </div>
        </div>
      )}

      {/* Ctrl with -, = and 0 size the code here. See font-zoom.ts. */}
      <div ref={hostRef} data-zoom-surface="code" className="relative min-h-0 flex-1">
        {ready ? (
          <MonacoEditor
            content={shown}
            revision={revision}
            language="json"
            onChange={handleChange}
            onSave={() => void save(false)}
            theme={resolvedTheme === "light" ? "light" : "vs-dark"}
          />
        ) : (
          <p role="status" className="p-4 text-sm text-muted-foreground">
            Loading {label}…
          </p>
        )}
      </div>

      <section
        aria-labelledby={problemsId}
        className="max-h-48 shrink-0 overflow-y-auto overscroll-contain border-t"
      >
        <h2
          id={problemsId}
          className="sticky top-0 bg-background px-4 pt-2 pb-1 text-xs font-semibold text-muted-foreground"
        >
          Problems <span className="tabular-nums">{check.issues.length}</span>
          {!check.valid && <span className="font-normal"> · Fix the errors to save</span>}
        </h2>
        {check.issues.length === 0 ? (
          <p className="px-4 pb-2.5 text-[13px] leading-5 text-muted-foreground">
            No problems found.
          </p>
        ) : (
          <ul className="space-y-1 px-4 pb-2.5">
            {check.issues.map((issue, index) => (
              <li
                key={`${index}:${issue.path ?? ""}:${issue.message}`}
                className="flex items-start gap-2 text-[13px] leading-5"
              >
                {issue.severity === "error" ? (
                  <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-destructive" aria-hidden />
                ) : (
                  <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-warning" aria-hidden />
                )}
                <span className="sr-only">{issue.severity === "error" ? "Error" : "Warning"}:</span>
                <span className="min-w-0 break-words">
                  {issue.path && (
                    <code className="me-1.5 font-mono text-foreground">{issue.path}</code>
                  )}
                  <span className="text-muted-foreground">{issue.message}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
