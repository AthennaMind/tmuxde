import { RefreshCw } from "lucide-react";
import { GroupedChanges } from "./grouped-changes";
import { useMainTabsStore } from "@/features/workspace/main-tabs-store";
import { PanelHeader, PanelIconButton } from "@/features/workspace/panel-header";
import { Notice } from "@/shared/notice";
import type { WorkspaceChanges } from "./use-workspace-changes";
import type { RepositoryState } from "./use-repository-state";

export function ChangesView({
  repo,
  workspace,
}: {
  repo: RepositoryState;
  workspace: WorkspaceChanges;
}) {
  const { context, paneId, client } = repo;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PanelHeader
        title={
          <span className="flex items-center gap-2">
            Changes{" "}
            {workspace.count > 0 && (
              <span className="rounded bg-muted px-1.5 text-xs font-normal tabular-nums">
                {workspace.count}
                {workspace.truncated ? "+" : ""}
              </span>
            )}
          </span>
        }
      >
        <PanelIconButton
          label="Refresh changes"
          icon={RefreshCw}
          onClick={repo.refresh}
          disabled={!client}
        />
      </PanelHeader>
      <div className="min-h-0 flex-1 overflow-auto">
        {repo.unavailable ? (
          <Notice>{repo.unavailable}</Notice>
        ) : !context || !client || !paneId ? (
          <Notice error={!!repo.error}>{repo.error ?? "Loading changes…"}</Notice>
        ) : (
          <GroupedChanges
            workspace={workspace}
            context={context}
            client={client}
            paneId={paneId}
            dense
            parentError={repo.error}
            onOpen={(root, path, scope) =>
              useMainTabsStore.getState().openFile({ paneId, path, scope, root, contextPath: root })
            }
            onOpenAll={(contextPath) =>
              useMainTabsStore.getState().openChanges({ paneId, contextPath })
            }
          />
        )}
      </div>
    </div>
  );
}
