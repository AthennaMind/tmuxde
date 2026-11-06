import { EditableFileTab } from "./editable-file-tab";
import { cn } from "@/shared/utils";
import { useRelayClient } from "@/features/connection/use-websocket";
import { isMarkdownPath } from "./markdown";
import { getFileViewMode } from "./file-utils";
import { changeTouchesDiff, changeTouchesFile } from "@/features/repository/repo-change";
import { useRepoChangeCount } from "@/features/repository/repo-watch-store";
import { useConnectionStore } from "@/features/connection/connection-store";
import { useMainTabsStore, type FileTab } from "@/features/workspace/main-tabs-store";
import { useSettingsStore } from "@/features/settings/settings-store";
import { FilePreview } from "@/features/repository/repository-preview";
import { Notice } from "@/shared/notice";
import { useRepositoryQuery } from "@/features/repository/use-repository-query";
import type { RepositoryClient } from "@/features/repository/repository-request";

/** A file or diff in the desktop main area, opened from the sidebar. */
export function FileTabView(props: { tab: FileTab; className?: string }) {
  if (!props.tab.scope && (props.tab.position || getFileViewMode(props.tab.path) === "text")) {
    return <EditableFileTab {...props} preview={<FileTabFallback tab={props.tab} />} />;
  }
  return <PreviewFileTab {...props} />;
}

function FileTabFallback({ tab }: { tab: FileTab }) {
  const client = useRelayClient();
  const wrap = useSettingsStore((state) => state.wrapLines);
  if (!client || client.status !== "connected")
    return <Notice>Connect to preview this file.</Notice>;
  return (
    <FileTabBody
      client={client}
      tab={tab}
      refresh={0}
      wrap={wrap}
      fullPath={tab.path}
      rendered={false}
      onOpenPath={() => {}}
    />
  );
}

function PreviewFileTab({ tab, className }: { tab: FileTab; className?: string }) {
  const client = useRelayClient();
  const status = useConnectionStore((s) => s.status);
  const wrap = useSettingsStore((s) => s.wrapLines);
  const rendered = useSettingsStore((s) => s.markdownPreview);
  const openFile = useMainTabsStore((s) => s.openFile);
  const fullPath = tab.scope && tab.root ? `${tab.root.replace(/\/$/, "")}/${tab.path}` : tab.path;
  const name = tab.path.split("/").pop() || tab.path;
  const markdown = !tab.scope && isMarkdownPath(fullPath);
  const showRendered = markdown && rendered;
  // A push that touches the file reloads it quietly. Staged and unstaged
  // diffs also follow the index and HEAD.
  const pushed = useRepoChangeCount((change) =>
    tab.scope
      ? !!tab.root && changeTouchesDiff(change, tab.root, tab.path, tab.scope !== "untracked")
      : changeTouchesFile(change, tab.path),
  );

  return (
    <section
      aria-label={name}
      // Ctrl with -, = and 0 size the code here. See font-zoom.ts.
      data-zoom-surface="code"
      // Desk distance code sizes for `text-code`. See globals.css.
      className={cn(
        "flex min-h-0 min-w-0 flex-col bg-background [--code-leading:1.6] [--code-meta-size:0.75rem] [--code-size:0.8125rem]",
        className,
      )}
    >
      {client && status === "connected" ? (
        <FileTabBody
          client={client}
          tab={tab}
          refresh={pushed}
          wrap={wrap}
          fullPath={fullPath}
          rendered={showRendered}
          onOpenPath={(path) =>
            openFile({
              machineId: tab.machineId,
              sessionName: tab.sessionName,
              paneId: tab.paneId,
              path,
            })
          }
        />
      ) : (
        <Notice>Connect to view this file.</Notice>
      )}
    </section>
  );
}

function FileTabBody({
  client,
  tab,
  refresh,
  wrap,
  fullPath,
  rendered,
  onOpenPath,
}: {
  client: RepositoryClient;
  tab: FileTab;
  refresh: number;
  wrap: boolean;
  fullPath: string;
  rendered: boolean;
  onOpenPath: (path: string) => void;
}) {
  const query = useRepositoryQuery(
    client,
    tab.scope
      ? {
          id: tab.paneId,
          action: "diff",
          path: tab.contextPath ?? tab.root ?? "",
          file: tab.path,
          scope: tab.scope,
        }
      : { id: tab.paneId, action: "read", path: tab.path },
    refresh,
    // A reload keeps the text on screen until the new text lands.
    { keepOnRefresh: true },
  );
  const content =
    query.result?.kind === "read" || query.result?.kind === "diff" ? query.result : undefined;
  if (query.error) return <Notice error>{query.error}</Notice>;
  if (query.loading && !content) return <Notice>Loading</Notice>;
  if (!content) return null;
  return (
    <FilePreview
      result={content}
      path={fullPath}
      wrap={wrap}
      size={tab.size}
      symlink={tab.symlink}
      rendered={rendered}
      onOpenPath={onOpenPath}
      machineId={tab.machineId}
    />
  );
}
