import { useEffect, useId, useMemo } from "react";
import {
  GitCommitHorizontal,
  GitCompareArrows,
  GitGraph,
  LayoutGrid,
  Settings,
  SquareTerminal,
  X,
} from "lucide-react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { cn } from "@/lib/utils";
import { RepositoryFileIcon } from "@/components/files/repository-file-icon";
import {
  inGroup,
  reconcileTabOrder,
  useMainTabsStore,
  TERMINAL_TAB,
  type CloseGroup,
  type FileTab,
  type TabOrigin,
} from "@/stores/main-tabs-store";
import { useMachineStore } from "@/stores/machine-store";
import { LAST_SESSION_KEY, clearStored } from "@/lib/storage-keys";
import { activateView, openMachineSession } from "@/lib/workspace-target";
import { useTabReorder } from "./use-tab-reorder";
import { useSessionStore } from "@/stores/session-store";

const SCOPE_SHORT = { staged: "staged", unstaged: "diff", untracked: "new" };

function terminalId(terminal: { machineId: string; sessionName: string }) {
  return JSON.stringify(["terminal", terminal.machineId, terminal.sessionName]);
}

function tabLabel(tab: FileTab) {
  return tab.path.split("/").pop() || tab.path;
}

/**
 * Terminal plus every open file, settings and the overview, above the
 * desktop main area.
 *
 * Session tabs are unique per machine and session. File and repository tabs
 * retain their origin when another terminal becomes active.
 */
export function MainTabs() {
  const tabs = useMainTabsStore((s) => s.tabs);
  const active = useMainTabsStore((s) => s.active);
  const savedOrder = useMainTabsStore((s) => s.order);
  const setOrder = useMainTabsStore((s) => s.setOrder);
  const reorderHelp = useId();
  const activate = activateView;
  const closeTab = useMainTabsStore((s) => s.closeTab);
  const closeTabs = useMainTabsStore((s) => s.closeTabs);
  const session = useSessionStore((s) => s.activeSessionId);

  const terminals = useMachineStore((s) => s.terminals);
  const machines = useMachineStore((s) => s.machines);
  const activeMachine = useMachineStore((s) => s.activeMachine);
  const machineName = (id: string) => machines.find((machine) => machine.id === id)?.name ?? id;

  const originName = (tab: TabOrigin) =>
    machines.length > 1 ? machineName(tab.machineId ?? "local") : undefined;

  const closeTerminal = (machine: string, name: string) => {
    useMachineStore.getState().closeTerminal(machine, name);
    if (machine !== activeMachine || name !== session) return;
    const remaining = useMachineStore.getState().terminals;
    const next = remaining.at(-1);
    if (next) openMachineSession(next.machineId, next.sessionName);
    else {
      useSessionStore.getState().setActiveSession(null);
      clearStored(LAST_SESSION_KEY);
    }
  };

  const order = useMemo(() => reconcileTabOrder(savedOrder, [
    ...terminals.map(terminalId),
    ...tabs.map((tab) => tab.id),
  ]), [savedOrder, terminals, tabs]);
  const { navProps, dragging, target, announcement } = useTabReorder(order, setOrder);
  useEffect(() => { setOrder(order); }, [order, setOrder]);
  const reorderProps = (id: string) => ({
    id,
    reorderHelp,
    dragging: dragging === id,
    dropSide: dragging !== id && target?.id === id ? target.side : undefined,
  });

  if (!tabs.length && !terminals.length) return null;

  const has = (group: CloseGroup) => tabs.some((tab) => inGroup(tab, group));

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <nav
          {...navProps}
          aria-label="Open views"
          className="flex min-h-11 shrink-0 items-end gap-0.5 overflow-x-auto border-b px-1.5 font-chrome scrollbar-none"
        >
          {[...terminals.map((terminal) => (
            <Tab
              key={terminalId(terminal)}
              {...reorderProps(terminalId(terminal))}
              label={terminal.sessionName}
              detail={machineName(terminal.machineId)}
              title={`${terminal.sessionName} on ${machineName(terminal.machineId)}`}
              icon={<SquareTerminal className="h-3.5 w-3.5 shrink-0" aria-hidden />}
              active={active === TERMINAL_TAB && terminal.machineId === activeMachine && terminal.sessionName === session}
              onSelect={() => openMachineSession(terminal.machineId, terminal.sessionName)}
              onClose={() => closeTerminal(terminal.machineId, terminal.sessionName)}
            />
          )), ...tabs.map((tab) =>
            tab.kind === "commit" ? (
              <Tab
                key={tab.id}
                {...reorderProps(tab.id)}
                label={tab.subject || tab.hash.slice(0, 7)}
                detail={[tab.subject ? tab.hash.slice(0, 7) : undefined, originName(tab)].filter(Boolean).join(" · ")}
                title={`${tab.hash.slice(0, 7)} ${tab.subject} (${machineName(tab.machineId ?? "local")})`.trim()}
                icon={
                  <GitCommitHorizontal
                    className="h-3.5 w-3.5 shrink-0"
                    aria-hidden
                  />
                }
                active={active === tab.id}
                onSelect={() => activate(tab.id)}
                onClose={() => {
                  closeTab(tab.id);
                  activateView(useMainTabsStore.getState().active);
                }}
              />
            ) : tab.kind === "graph" || tab.kind === "changes" ? (
              <Tab
                key={tab.id}
                {...reorderProps(tab.id)}
                label={tab.kind === "graph" ? "Graph" : "Current changes"}
                detail={
                  [tab.contextPath.replace(/\/+$/, "").split("/").pop() ||
                    tab.contextPath, originName(tab)].filter(Boolean).join(" · ")
                }
                title={`${tab.kind === "graph" ? "Graph" : "Current changes"} of ${tab.contextPath}`}
                icon={tab.kind === "graph" ? <GitGraph className="h-3.5 w-3.5 shrink-0" aria-hidden /> : <GitCompareArrows className="h-3.5 w-3.5 shrink-0" aria-hidden />}
                active={active === tab.id}
                onSelect={() => activate(tab.id)}
                onClose={() => {
                  closeTab(tab.id);
                  activateView(useMainTabsStore.getState().active);
                }}
              />
            ) : tab.kind === "settings" ? (
              <Tab
                key={tab.id}
                {...reorderProps(tab.id)}
                label="Settings"
                icon={<Settings className="h-3.5 w-3.5 shrink-0" aria-hidden />}
                active={active === tab.id}
                onSelect={() => activate(tab.id)}
                onClose={() => {
                  closeTab(tab.id);
                  activateView(useMainTabsStore.getState().active);
                }}
              />
            ) : tab.kind === "overview" ? (
              <Tab
                key={tab.id}
                {...reorderProps(tab.id)}
                label="Overview"
                icon={<LayoutGrid className="h-3.5 w-3.5 shrink-0" aria-hidden />}
                active={active === tab.id}
                onSelect={() => activate(tab.id)}
                onClose={() => {
                  closeTab(tab.id);
                  activateView(useMainTabsStore.getState().active);
                }}
              />
            ) : (
              <Tab
                key={tab.id}
                {...reorderProps(tab.id)}
                label={tabLabel(tab)}
                detail={[tab.scope ? SCOPE_SHORT[tab.scope] : undefined, originName(tab)].filter(Boolean).join(" · ")}
                title={tab.scope ? `${tab.path} (${tab.scope} changes)` : tab.path}
                icon={
                  <RepositoryFileIcon path={tab.path} className="h-3.5 w-3.5" />
                }
                active={active === tab.id}
                onSelect={() => activate(tab.id)}
                onClose={() => {
                  closeTab(tab.id);
                  activateView(useMainTabsStore.getState().active);
                }}
              />
            ),
          )].sort((a, b) => order.indexOf(String(a.key)) - order.indexOf(String(b.key)))}
          <span id={reorderHelp} className="sr-only">Drag to reorder, or press Alt+ArrowLeft or Alt+ArrowRight.</span>
          <span className="sr-only" role="status">{announcement}</span>
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
  id,
  reorderHelp,
  dragging,
  dropSide,
  label,
  detail,
  title,
  icon,
  active,
  onSelect,
  onClose,
}: {
  id: string;
  reorderHelp: string;
  dragging: boolean;
  dropSide?: "before" | "after";
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
      data-view-id={id}
      className={cn(
        "group relative -mb-px flex h-9 max-w-64 shrink-0 items-center rounded-t-md border border-b-0 text-[13px]",
        dragging && "opacity-40",
        dropSide === "before" && "before:absolute before:inset-y-0 before:-left-px before:w-0.5 before:bg-primary",
        dropSide === "after" && "after:absolute after:inset-y-0 after:-right-px after:w-0.5 after:bg-primary",
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
        data-view-handle
        draggable
        aria-describedby={reorderHelp}
        aria-keyshortcuts="Alt+ArrowLeft Alt+ArrowRight"
        aria-current={active ? "page" : undefined}
        title={title ?? label}
        onClick={onSelect}
        className={cn(
          "flex h-full min-w-0 cursor-grab items-center active:cursor-grabbing gap-1.5 rounded-t-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          onClose ? "ps-3 pe-1" : "px-3",
        )}
      >
        {icon}
        <span className="truncate">{label}</span>
        {detail && (
          <span className="max-w-28 shrink-0 truncate text-xs text-muted-foreground">{detail}</span>
        )}
      </button>
      {onClose && (
        <button
          type="button"
          aria-label={`Close ${label}`}
          title="Close"
          onClick={onClose}
          className={cn(
            "me-1 flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            !active && "opacity-0 group-hover:opacity-100",
          )}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}
