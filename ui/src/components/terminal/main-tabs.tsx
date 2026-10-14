import { GitCommitHorizontal, Settings, SquareTerminal, X } from "lucide-react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@repo/ui/components/ui/context-menu";
import { cn } from "@repo/ui/lib/utils";
import { RepositoryFileIcon } from "@/components/files/repository-file-icon";
import {
  inGroup,
  useMainTabsStore,
  TERMINAL_TAB,
  type CloseGroup,
  type FileTab,
} from "@/stores/main-tabs-store";
import { useSessionStore } from "@/stores/session-store";

const SCOPE_SHORT = { staged: "staged", unstaged: "diff", untracked: "new" };

function tabLabel(tab: FileTab) {
  return tab.path.split("/").pop() || tab.path;
}

/**
 * Terminal plus every open file and settings, above the desktop main area.
 *
 * Only drawn once another tab is open. With the terminal alone there is nothing
 * to switch between, and the row would cost the terminal 44px for nothing.
 *
 * Right click anywhere on the row offers bulk close. The terminal never closes.
 */
export function MainTabs() {
  const tabs = useMainTabsStore((s) => s.tabs);
  const active = useMainTabsStore((s) => s.active);
  const activate = useMainTabsStore((s) => s.activate);
  const closeTab = useMainTabsStore((s) => s.closeTab);
  const closeTabs = useMainTabsStore((s) => s.closeTabs);
  const session = useSessionStore((s) => s.activeSessionId);

  if (!tabs.length) return null;

  const has = (group: CloseGroup) => tabs.some((tab) => inGroup(tab, group));

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <nav
          aria-label="Open views"
          className="flex min-h-11 shrink-0 items-end gap-0.5 overflow-x-auto border-b px-1.5 font-chrome scrollbar-none"
        >
          <Tab
            label={session ?? "Terminal"}
            icon={<SquareTerminal className="h-3.5 w-3.5 shrink-0" aria-hidden />}
            active={active === TERMINAL_TAB}
            onSelect={() => activate(TERMINAL_TAB)}
          />
          {tabs.map((tab) =>
            tab.kind === "commit" ? (
              <Tab
                key={tab.id}
                label={tab.subject || tab.hash.slice(0, 7)}
                detail={tab.subject ? tab.hash.slice(0, 7) : undefined}
                title={`${tab.hash.slice(0, 7)} ${tab.subject}`.trim()}
                icon={
                  <GitCommitHorizontal
                    className="h-3.5 w-3.5 shrink-0"
                    aria-hidden
                  />
                }
                active={active === tab.id}
                onSelect={() => activate(tab.id)}
                onClose={() => closeTab(tab.id)}
              />
            ) : tab.kind === "settings" ? (
              <Tab
                key={tab.id}
                label="Settings"
                icon={<Settings className="h-3.5 w-3.5 shrink-0" aria-hidden />}
                active={active === tab.id}
                onSelect={() => activate(tab.id)}
                onClose={() => closeTab(tab.id)}
              />
            ) : (
              <Tab
                key={tab.id}
                label={tabLabel(tab)}
                detail={tab.scope ? SCOPE_SHORT[tab.scope] : undefined}
                title={tab.scope ? `${tab.path} (${tab.scope} changes)` : tab.path}
                icon={
                  <RepositoryFileIcon path={tab.path} className="h-3.5 w-3.5" />
                }
                active={active === tab.id}
                onSelect={() => activate(tab.id)}
                onClose={() => closeTab(tab.id)}
              />
            ),
          )}
        </nav>
      </ContextMenuTrigger>
      {/* Portalled out of the row, so it does not inherit the face. */}
      <ContextMenuContent className="min-w-40 font-chrome text-[13px]">
        <ContextMenuItem onSelect={() => closeTabs("all")}>
          Close all
        </ContextMenuItem>
        <ContextMenuItem
          disabled={!has("diffs")}
          onSelect={() => closeTabs("diffs")}
        >
          Close diffs
        </ContextMenuItem>
        <ContextMenuItem
          disabled={!has("files")}
          onSelect={() => closeTabs("files")}
        >
          Close files
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

function Tab({
  label,
  detail,
  title,
  icon,
  active,
  onSelect,
  onClose,
}: {
  label: string;
  detail?: string;
  title?: string;
  icon: React.ReactNode;
  active: boolean;
  onSelect: () => void;
  onClose?: () => void;
}) {
  return (
    <div
      className={cn(
        "group -mb-px flex h-9 max-w-64 shrink-0 items-center rounded-t-md border border-b-0 text-[13px]",
        active
          ? "border-border bg-background text-foreground"
          : "border-transparent text-muted-foreground hover:bg-accent/50 hover:text-foreground",
      )}
      onAuxClick={(event) => {
        // Middle click closes, like a browser tab.
        if (event.button === 1 && onClose) {
          event.preventDefault();
          onClose();
        }
      }}
    >
      <button
        type="button"
        aria-current={active ? "page" : undefined}
        title={title ?? label}
        onClick={onSelect}
        className={cn(
          "flex h-full min-w-0 items-center gap-1.5 rounded-t-md focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
          onClose ? "ps-3 pe-1" : "px-3",
        )}
      >
        {icon}
        <span className="truncate">{label}</span>
        {detail && (
          <span className="shrink-0 text-xs text-muted-foreground">{detail}</span>
        )}
      </button>
      {onClose && (
        <button
          type="button"
          aria-label={`Close ${label}`}
          title="Close"
          onClick={onClose}
          className={cn(
            "me-1 flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
            !active && "opacity-0 group-hover:opacity-100",
          )}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}
