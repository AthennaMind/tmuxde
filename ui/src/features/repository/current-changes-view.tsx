import { useEffect, useRef, useState } from "react";
import { ArrowLeft, GitCompareArrows, RefreshCw, WrapText, X } from "lucide-react";
import { cn } from "@/shared/utils";
import { sameRoot } from "./repo-change";
import { useRelayClient } from "@/features/connection/use-websocket";
import { useVisibleInterval } from "@/shared/use-visible-interval";
import { filesDisabled, useConnectionStore } from "@/features/connection/connection-store";
import { useMainTabsStore, type ChangesTab } from "@/features/workspace/main-tabs-store";
import { useRepoWatch, useRepoWatchStore, watchHealthy } from "./repo-watch-store";
import { useSessionTreeStore } from "@/features/session/session-tree-store";
import { useSettingsStore } from "@/features/settings/settings-store";
import { FileChangesDetail } from "./commit-view";
import { loadCurrentChanges, type CurrentChangesResult } from "./current-changes";
import { Notice } from "./repository-preview";
import type { RepositoryClient } from "./repository-request";

export function ChangesTabView({ tab, className }: { tab: ChangesTab; className?: string }) {
  const client = useRelayClient();
  const status = useConnectionStore((s) => s.status);
  const capabilities = useConnectionStore((s) => s.capabilities);
  const supported = useConnectionStore((s) => s.features.has("repo:request"));
  const unavailable = filesDisabled(capabilities)
    ? "File access is disabled for this connection."
    : status !== "connected" || !client
      ? "Connect to view current changes."
      : !supported
        ? "Update tmuxde on this machine to view changes."
        : null;
  return unavailable || !client ? (
    <div className={cn("bg-background", className)}>
      <Notice>{unavailable}</Notice>
    </div>
  ) : (
    <CurrentChangesView
      client={client}
      paneId={tab.paneId}
      path={tab.contextPath}
      className={className}
      onClose={() => useMainTabsStore.getState().closeTab(tab.id)}
    />
  );
}

/** The last load of current changes, and what it was loaded for. */
interface Answer {
  client: RepositoryClient;
  /** Attach, pane and folder. */
  view: string;
  result?: CurrentChangesResult;
  error?: string;
  /** A reload after this answer is in flight. */
  reloading: boolean;
}

/** Mounted only while visible. Requests stay on the repository opened. */
export function CurrentChangesView({
  client,
  paneId,
  path,
  touch = false,
  onClose,
  onBack,
  className,
}: {
  client: RepositoryClient;
  paneId: string;
  path: string;
  touch?: boolean;
  onClose?: () => void;
  onBack?: () => void;
  className?: string;
}) {
  const wrap = useSettingsStore((s) => s.wrapLines);
  const setWrap = useSettingsStore((s) => s.setWrapLines);
  const attached = useSessionTreeStore((s) => s.attachedSession !== null);
  const attachCount = useSessionTreeStore((s) => s.attachCount);
  // Answers carry what they were loaded for. Another client, pane, folder or
  // attach starts empty, so nothing has to reset them.
  const view = `${attachCount}:${paneId}:${path}`;
  const [answer, setAnswer] = useState<Answer>();
  const current =
    attached && answer?.client === client && answer.view === view ? answer : undefined;
  const result = current?.result;
  const error = current?.error;
  // The first load has no answer yet. Later loads keep the last one on screen.
  const loading = !current || current.reloading;
  const reload = useRef(() => {});
  const watch = useRepoWatch(attached ? client : null, result?.root, { paneId, path });

  useEffect(() => {
    if (!attached) return;
    const controller = new AbortController();
    const mine = (prev: Answer | undefined): prev is Answer =>
      prev?.client === client && prev.view === view;
    let busy = false;
    let again = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let root = path;
    async function load() {
      busy = true;
      try {
        const next = await loadCurrentChanges(client, paneId, path, controller.signal);
        if (controller.signal.aborted) return;
        root = next.root ?? path;
        setAnswer({ client, view, result: next, reloading: false });
      } catch (cause) {
        if (controller.signal.aborted) return;
        const message = cause instanceof Error ? cause.message : "Could not load changes.";
        setAnswer((prev) => ({
          ...(mine(prev) ? prev : { client, view }),
          error: message,
          reloading: false,
        }));
      } finally {
        busy = false;
        if (again && !controller.signal.aborted) {
          again = false;
          refresh();
        }
      }
    }
    // A reload spins the button and keeps the last answer on screen. One
    // runs at a time. One asked for meanwhile runs after it.
    function refresh() {
      if (controller.signal.aborted) return;
      if (busy) {
        again = true;
        return;
      }
      setAnswer((prev) => (mine(prev) ? { ...prev, reloading: true } : prev));
      void load();
    }
    reload.current = refresh;
    const unsubscribe = useRepoWatchStore.subscribe((state, previous) => {
      const change = state.lastChange;
      if (!change || change === previous.lastChange || !sameRoot(change, root)) return;
      clearTimeout(timer);
      timer = setTimeout(refresh, 200);
    });
    void load();
    return () => {
      controller.abort();
      clearTimeout(timer);
      unsubscribe();
      reload.current = () => {};
    };
  }, [client, paneId, path, attached, view]);

  useVisibleInterval(() => reload.current(), watchHealthy(watch) ? 120_000 : 15_000, {
    enabled: attached,
    debounceMs: 1_000,
  });
  const button = cn(
    "flex shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
    touch ? "h-11 w-11" : "h-8 w-8",
  );
  return (
    <section
      aria-label="Current changes"
      data-zoom-surface="code"
      className={cn(
        "flex min-h-0 min-w-0 flex-1 flex-col bg-background [--code-leading:1.6] [--code-meta-size:0.75rem] [--code-size:0.8125rem]",
        className,
      )}
    >
      <div
        className={cn(
          "flex min-h-11 shrink-0 items-center gap-2 border-b ps-3 pe-1",
          !touch && "font-chrome",
        )}
      >
        {onBack && (
          <button type="button" aria-label="Back to changes" onClick={onBack} className={button}>
            <ArrowLeft className="h-4 w-4" />
          </button>
        )}
        <GitCompareArrows className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium">Current changes</span>
        <button
          type="button"
          aria-label="Refresh changes"
          title="Refresh changes"
          onClick={() => reload.current()}
          className={button}
        >
          <RefreshCw
            className={cn("h-4 w-4", loading && "animate-spin motion-reduce:animate-none")}
          />
        </button>
        <button
          type="button"
          aria-label="Wrap lines"
          title="Wrap lines"
          aria-pressed={wrap}
          onClick={() => setWrap(!wrap)}
          className={button}
        >
          <WrapText className={cn("h-4 w-4", wrap && "text-primary")} />
        </button>
        {onClose && (
          <button
            type="button"
            aria-label="Close"
            title="Close"
            onClick={onClose}
            className={button}
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>
      {error && <Notice error>{error} Use Refresh changes to try again.</Notice>}
      {!result ? (
        !error && <Notice>Loading current changes</Notice>
      ) : !result.root ? (
        <Notice>This folder is outside a Git repository.</Notice>
      ) : (
        <FileChangesDetail
          result={result}
          wrap={wrap}
          touch={touch}
          header={
            <header className="border-b px-4 py-4">
              <h2 className="text-base font-semibold">Uncommitted changes</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Staged, unstaged and untracked files.
              </p>
              <p className="mt-3 break-all text-xs text-muted-foreground">{result.root}</p>
              {result.branch && <p className="mt-1 text-sm">{result.branch}</p>}
            </header>
          }
        />
      )}
    </section>
  );
}
