"use client";

import { useState } from "react";
import { RefreshCw, WrapText, X } from "lucide-react";
import { cn } from "@repo/ui/lib/utils";
import { useRelayClient } from "@/hooks/use-websocket";
import { shortenPath } from "@/lib/tmux-labels";
import { useConnectionStore } from "@/stores/connection-store";
import { useMainTabsStore, type FileTab } from "@/stores/main-tabs-store";
import { useSettingsStore } from "@/stores/settings-store";
import { RepositoryFileIcon } from "./repository-file-icon";
import { FilePreview, Notice, useRepositoryQuery } from "./repository-preview";
import type { RepositoryClient } from "./repository-request";

const SCOPE_LABELS = {
  staged: "Staged changes",
  unstaged: "Unstaged changes",
  untracked: "Untracked file",
};

/** A file or diff in the desktop main area, opened from the sidebar. */
export function FileTabView({
  tab,
  className,
}: {
  tab: FileTab;
  className?: string;
}) {
  const client = useRelayClient();
  const status = useConnectionStore((s) => s.status);
  const closeTab = useMainTabsStore((s) => s.closeTab);
  const [refresh, setRefresh] = useState(0);
  const wrap = useSettingsStore((s) => s.wrapLines);
  const setWrap = useSettingsStore((s) => s.setWrapLines);
  const fullPath =
    tab.scope && tab.root
      ? `${tab.root.replace(/\/$/, "")}/${tab.path}`
      : tab.path;
  const name = tab.path.split("/").pop() || tab.path;

  return (
    <section
      aria-label={name}
      // Ctrl with -, = and 0 size the code here. See font-zoom.ts.
      data-zoom-surface="code"
      // Desk distance code sizes for `text-code`. See app/globals.css.
      className={cn(
        "flex min-h-0 min-w-0 flex-col bg-background [--code-leading:1.6] [--code-meta-size:0.75rem] [--code-size:0.8125rem]",
        className,
      )}
    >
      <div className="flex min-h-11 shrink-0 items-center gap-2 border-b ps-3 pe-1 font-chrome">
        <RepositoryFileIcon path={fullPath} />
        <span className="shrink-0 text-[13px] font-medium">{name}</span>
        {tab.scope && (
          <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
            {SCOPE_LABELS[tab.scope]}
          </span>
        )}
        <span
          className="min-w-0 flex-1 truncate text-xs text-muted-foreground"
          title={fullPath}
        >
          {shortenPath(fullPath)}
        </span>
        <HeaderButton
          label="Wrap lines"
          pressed={wrap}
          onClick={() => setWrap(!wrap)}
        >
          <WrapText className={cn("h-4 w-4", wrap && "text-primary")} />
        </HeaderButton>
        <HeaderButton
          label="Reload"
          onClick={() => setRefresh((value) => value + 1)}
        >
          <RefreshCw className="h-4 w-4" />
        </HeaderButton>
        <HeaderButton label="Close" onClick={() => closeTab(tab.id)}>
          <X className="h-4 w-4" />
        </HeaderButton>
      </div>
      {client && status === "connected" ? (
        <FileTabBody
          client={client}
          tab={tab}
          refresh={refresh}
          wrap={wrap}
          fullPath={fullPath}
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
}: {
  client: RepositoryClient;
  tab: FileTab;
  refresh: number;
  wrap: boolean;
  fullPath: string;
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
  );
  const content =
    query.result?.kind === "read" || query.result?.kind === "diff"
      ? query.result
      : undefined;
  if (query.error) return <Notice error>{query.error}</Notice>;
  if (query.loading) return <Notice>Loading</Notice>;
  if (!content) return null;
  return (
    <FilePreview result={content} path={fullPath} wrap={wrap} size={tab.size} />
  );
}

export function HeaderButton({
  label,
  pressed,
  onClick,
  children,
}: {
  label: string;
  pressed?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={pressed}
      title={label}
      onClick={onClick}
      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
    >
      {children}
    </button>
  );
}
