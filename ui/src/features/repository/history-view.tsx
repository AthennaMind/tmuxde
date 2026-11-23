import type { WorkspaceChanges } from "./use-workspace-changes";
import { RefreshCw } from "lucide-react";
import { useConnectionStore } from "@/features/connection/connection-store";
import { useMainTabsStore } from "@/features/workspace/main-tabs-store";
import { PanelHeader, PanelIconButton } from "@/features/workspace/panel-header";
import { Notice as Note } from "@/shared/notice";
import { GroupedHistory } from "./grouped-history";
import type { RepositoryState } from "./use-repository-state";

export function HistoryView({
  repo,
  workspace,
}: {
  repo: RepositoryState;
  workspace: WorkspaceChanges;
}) {
  const supported = useConnectionStore((s) => s.features.has("repo:history"));
  const graph = useConnectionStore((s) => s.features.has("repo:graph"));
  const { context, paneId, client } = repo;
  const selected = useMainTabsStore((s) =>
    s.tabs.find((t) => t.id === s.active && t.kind === "commit"),
  );
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PanelHeader title="History">
        <PanelIconButton
          label="Refresh history"
          icon={RefreshCw}
          onClick={repo.refresh}
          disabled={!client || !supported}
        />
      </PanelHeader>
      <div className="min-h-0 flex-1 overflow-auto">
        {repo.unavailable ? (
          <Note>{repo.unavailable}</Note>
        ) : !supported ? (
          <Note>Update tmuxde on this machine to browse history.</Note>
        ) : !context || !paneId || !client ? (
          <Note error={!!repo.error}>{repo.error ?? "Loading history"}</Note>
        ) : (
          <GroupedHistory
            context={context}
            paneId={paneId}
            client={client}
            refresh={repo.refreshKey}
            workspace={workspace}
            tick={repo.status}
            dense
            selected={selected?.kind === "commit" ? selected : undefined}
            onGraph={
              graph
                ? (contextPath) => useMainTabsStore.getState().openGraph({ paneId, contextPath })
                : undefined
            }
            onOpen={(contextPath, commit) =>
              useMainTabsStore
                .getState()
                .openCommit({ paneId, contextPath, hash: commit.hash, subject: commit.subject })
            }
          />
        )}
      </div>
    </div>
  );
}
