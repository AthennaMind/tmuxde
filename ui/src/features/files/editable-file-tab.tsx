import { useEffect, useState } from "react";
import type { FileTab } from "@/features/workspace/main-tabs-store";
import { useMainTabsStore } from "@/features/workspace/main-tabs-store";
import { useSettingsStore } from "@/features/settings/settings-store";
import { useConnectionStore } from "@/features/connection/connection-store";
import { get } from "@/features/connection/relay-registry";
import { lazyComponent } from "@/shared/lazy-component";
import { Notice } from "@/shared/notice";
import { FileLoading } from "./file-loading";
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

const MonacoEditor = lazyComponent(
  () => import("./monaco-editor").then((module) => module.MonacoEditor),
  <FileLoading />,
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
  const setRendered = useSettingsStore((state) => state.setMarkdownPreview);
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
  const comparing = compare && !!draft?.conflict;
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
          <div className="min-w-0 flex-1">
            <p>{draft.error}</p>
            <p className="break-all font-mono text-xs">{tab.path}</p>
          </div>
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
        comparing && draft.conflict ? (
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
              position={tab.position}
              onNavigate={() => {
                if (tab.position)
                  useMainTabsStore.getState().clearFilePosition(tab.id, tab.position.requestId);
              }}
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
      ) : draft?.online || client?.status === "connected" || !draft ? (
        <FileLoading />
      ) : (
        <Notice>Connect to edit this file.</Notice>
      )}
      {markdown && draft?.base && (
        <div
          role="group"
          aria-label="Markdown view"
          className="flex shrink-0 justify-end gap-1 border-t px-2 py-1"
        >
          {[
            { label: readOnly ? "Source" : "Edit", value: false },
            { label: "Preview", value: true },
          ].map(({ label, value }) => (
            <Button
              key={String(value)}
              size="sm"
              variant="ghost"
              aria-pressed={!comparing && rendered === value}
              className={cn("h-7 text-xs", !comparing && rendered === value && "bg-accent")}
              onClick={() => {
                setCompare(false);
                setRendered(value);
              }}
            >
              {label}
            </Button>
          ))}
        </div>
      )}
    </section>
  );
}
