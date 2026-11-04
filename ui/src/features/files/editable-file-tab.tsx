import { useEffect, useState } from "react";
import type { FileTab } from "@/features/workspace/main-tabs-store";
import { useMainTabsStore } from "@/features/workspace/main-tabs-store";
import { useSettingsStore } from "@/features/settings/settings-store";
import { useConnectionStore } from "@/features/connection/connection-store";
import { get } from "@/features/connection/relay-registry";
import { lazyComponent } from "@/shared/lazy-component";
import { Notice } from "@/shared/notice";
import { cn } from "@/shared/utils";
import { Button } from "@/components/ui/button";
import { getMonacoLanguage } from "./file-utils";
import { isMarkdownPath } from "./markdown";
import {
  acceptDiskVersion,
  checkDraft,
  draftKey,
  draftModified,
  editDraft,
  openDraft,
  saveDraft,
  useFileDrafts,
} from "./file-drafts";

const MonacoEditor = lazyComponent(() =>
  import("./monaco-editor").then((module) => module.MonacoEditor),
);
const MarkdownPreview = lazyComponent(() =>
  import("./markdown-preview").then((module) => module.MarkdownPreview),
);
const FileConflict = lazyComponent(() =>
  import("./file-conflict").then((module) => module.FileConflict),
);

export function EditableFileTab({
  tab,
  className,
  preview,
}: {
  tab: FileTab;
  className?: string;
  preview: React.ReactNode;
}) {
  const key = draftKey(tab.machineId, tab.path);
  const draft = useFileDrafts((state) => state.drafts[key]);
  const openFile = useMainTabsStore((state) => state.openFile);
  const autoSave = useSettingsStore((state) => state.autoSave);
  const wrap = useSettingsStore((state) => state.wrapLines);
  const rendered = useSettingsStore((state) => state.markdownPreview);
  const capabilities = useConnectionStore((state) => state.capabilities);
  const [compare, setCompare] = useState(false);
  const client = get(tab.machineId ?? "local");
  const markdown = isMarkdownPath(tab.path);
  const readOnly =
    !!draft?.moving ||
    !draft?.base?.writable ||
    !!capabilities?.readOnly ||
    (capabilities !== null && capabilities.files !== "write");
  const modified = draftModified(draft);
  const canSave =
    !readOnly && modified && draft?.online && !draft.saving && !draft.checking && !draft.needsCheck;
  const save = () => {
    if (client && canSave) void saveDraft(key, client);
  };

  useEffect(() => openDraft(tab.machineId, tab.path), [tab.machineId, tab.path]);

  const status = draft?.moving
    ? "Moving"
    : !draft?.online
      ? "Offline"
      : draft.saving
        ? "Saving"
        : draft.conflict
          ? "Conflict"
          : draft.error
            ? "Save unavailable"
            : !draft.base
              ? "Loading"
              : readOnly
                ? "Read-only"
                : modified
                  ? "Modified"
                  : "Saved";

  return (
    <section
      aria-label={tab.path.split("/").pop()}
      data-zoom-surface="code"
      className={cn("flex min-h-0 min-w-0 flex-col bg-background", className)}
    >
      <span role="status" className="sr-only">
        {status}
      </span>
      {draft?.error && (
        <div
          role="alert"
          className="flex items-center gap-2 border-b px-3 py-2 text-sm text-destructive"
        >
          <span className="flex-1">
            {draft.error} {!draft.base && "Preview remains available."}
          </span>
          <Button
            size="sm"
            variant="outline"
            disabled={!client || !draft.online || draft.checking}
            onClick={() => {
              if (client) void checkDraft(key, client);
            }}
          >
            Retry
          </Button>
        </div>
      )}
      {draft?.conflict ? (
        <div className="flex flex-wrap items-center gap-2 border-b bg-warning/10 px-3 py-2 text-sm">
          <span className="flex-1">File changed on disk. Your edits are kept.</span>
          <Button size="sm" variant="outline" onClick={() => setCompare(!compare)}>
            {compare ? "Back to editor" : "Compare"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={draft.saving || draft.checking}
            onClick={() => acceptDiskVersion(key)}
          >
            Use disk version
          </Button>
          <Button
            size="sm"
            disabled={!canSave || !draft.conflict.writable}
            onClick={() => {
              if (client) void saveDraft(key, client, true);
            }}
          >
            Save my version
          </Button>
        </div>
      ) : draft?.paused && modified && autoSave ? (
        <p className="border-b px-3 py-2 text-xs text-muted-foreground">
          Autosave paused. Review your edits and save to resume.
        </p>
      ) : null}
      {draft?.base ? (
        compare && draft.conflict ? (
          <FileConflict path={tab.path} disk={draft.conflict.content} draft={draft.content} />
        ) : markdown && rendered ? (
          <div className="min-h-0 flex-1 overflow-auto">
            <MarkdownPreview
              path={tab.path}
              content={draft.content}
              onOpenPath={(path) => openFile({ ...tab, path })}
            />
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-hidden">
            <MonacoEditor
              content={draft.content}
              revision={draft.revision}
              modelPath={`tmuxde-file://draft/${encodeURIComponent(draft.modelKey)}`}
              language={getMonacoLanguage(tab.path)}
              readOnly={readOnly}
              onChange={(content) => editDraft(key, content)}
              onSave={save}
              wordWrap={wrap ? "on" : "off"}
            />
          </div>
        )
      ) : draft?.error ? (
        preview
      ) : (
        <Notice>{draft?.online ? "Loading file" : "Connect to edit this file."}</Notice>
      )}
    </section>
  );
}
