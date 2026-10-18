import { useEffect, useState } from "react";
import { GitCommitHorizontal, WrapText, X } from "lucide-react";
import { cn } from "@/shared/utils";
import { useRelayClient } from "@/features/connection/use-websocket";
import { useConnectionStore } from "@/features/connection/connection-store";
import { useMainTabsStore, type CommitTab } from "@/features/workspace/main-tabs-store";
import { useSettingsStore } from "@/features/settings/settings-store";
import { CommitDetail } from "./commit-view";
import { HeaderButton } from "@/features/workspace/panel-header";
import { Notice } from "./repository-preview";
import { useRepositoryQuery } from "./use-repository-query";
import type { RepositoryClient } from "./repository-request";

/** A commit and its whole patch in the desktop main area. */
export function CommitTabView({ tab, className }: { tab: CommitTab; className?: string }) {
  const client = useRelayClient();
  const status = useConnectionStore((s) => s.status);
  const closeTab = useMainTabsStore((s) => s.closeTab);
  const wrap = useSettingsStore((s) => s.wrapLines);
  const setWrap = useSettingsStore((s) => s.setWrapLines);
  const short = tab.hash.slice(0, 7);

  return (
    <section
      aria-label={`Commit ${short}`}
      // Ctrl with -, = and 0 size the code here. See font-zoom.ts.
      data-zoom-surface="code"
      // Desk distance code sizes for `text-code`. See globals.css.
      className={cn(
        "flex min-h-0 min-w-0 flex-col bg-background [--code-leading:1.6] [--code-meta-size:0.75rem] [--code-size:0.8125rem]",
        className,
      )}
    >
      <div className="flex min-h-11 shrink-0 items-center gap-2 border-b ps-3 pe-1 font-chrome">
        <GitCommitHorizontal className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
        <span className="min-w-0 truncate text-[13px] font-medium" title={tab.subject}>
          {tab.subject || short}
        </span>
        {tab.subject && (
          <span className="shrink-0 font-mono text-xs text-muted-foreground">{short}</span>
        )}
        <span className="flex-1" />
        <HeaderButton label="Wrap lines" pressed={wrap} onClick={() => setWrap(!wrap)}>
          <WrapText className={cn("h-4 w-4", wrap && "text-primary")} />
        </HeaderButton>
        <HeaderButton label="Close" onClick={() => closeTab(tab.id)}>
          <X className="h-4 w-4" />
        </HeaderButton>
      </div>
      {client && status === "connected" ? (
        <CommitTabBody client={client} tab={tab} wrap={wrap} />
      ) : (
        <Notice>Connect to view this commit.</Notice>
      )}
    </section>
  );
}

function CommitTabBody({
  client,
  tab,
  wrap,
}: {
  client: RepositoryClient;
  tab: CommitTab;
  wrap: boolean;
}) {
  const [retry, setRetry] = useState(0);
  const query = useRepositoryQuery(
    client,
    {
      id: tab.paneId,
      action: "show",
      path: tab.contextPath,
      commit: tab.hash,
    },
    retry,
  );
  const result = query.result?.kind === "show" ? query.result : undefined;

  // A tab opened from a parent link learns its subject here.
  const subject = result?.commit.subject;
  useEffect(() => {
    if (subject !== undefined) useMainTabsStore.getState().nameCommit(tab.id, subject);
  }, [subject, tab.id]);

  if (query.error)
    return (
      <div className="px-4 py-6">
        <p role="alert" className="text-sm text-destructive">
          {query.error}
        </p>
        <button
          type="button"
          onClick={() => setRetry((n) => n + 1)}
          className="mt-3 min-h-8 rounded-md border px-3 text-[13px] hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          Try again
        </button>
      </div>
    );
  if (query.loading || !result) return <Notice>Loading commit</Notice>;
  return (
    <CommitDetail
      result={result}
      wrap={wrap}
      onOpenCommit={(hash) =>
        useMainTabsStore.getState().openCommit({
          machineId: tab.machineId,
          sessionName: tab.sessionName,
          paneId: tab.paneId,
          hash,
          subject: "",
          contextPath: tab.contextPath,
        })
      }
    />
  );
}
