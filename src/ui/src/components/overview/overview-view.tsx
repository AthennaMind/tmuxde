import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { create } from "zustand";
import {
  Loader2,
  Lock,
  Plus,
  PlugZap,
  Search,
  SquareTerminal,
  X,
} from "lucide-react";
import type { ClientMessage } from "@/protocol";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { LivePreview } from "./live-preview";
import { PreviewControls } from "./preview-controls";
import { getTerminalHandle } from "@/components/terminal/terminal-handle";
import { subscribeKeys } from "@/lib/unlocked";
import { isSessionLocked } from "@/lib/lock-store";
import { isMobileViewport } from "@/lib/mobile-query";
import { cn } from "@/lib/utils";
import { openMachineSession, openWorkspace } from "@/lib/workspace-target";
import { isReadOnly, useConnectionStore } from "@/stores/connection-store";
import { useMachineStore } from "@/stores/machine-store";
import { TERMINAL_TAB, useMainTabsStore } from "@/stores/main-tabs-store";
import { usePaneStore } from "@/stores/pane-store";
import { useSessionStore } from "@/stores/session-store";
import { useSessionTreeStore } from "@/stores/session-tree-store";
import { paneCellName, paneCellText } from "@/lib/pane-grid-layout";
import {
  buildMachine,
  overviewPanes,
  machineStatusLabel,
  normalizeQuery,
  plural,
  type LiveState,
  type OverviewPane,
} from "./overview-model";

/**
 * The filter outlives the page. The page mounts only while its tab is in
 * front, and a trip to a pane and back should find the same list.
 */
const useOverviewFilter = create<{ query: string; setQuery: (query: string) => void }>()(
  (set) => ({ query: "", setQuery: (query) => set({ query }) }),
);

/** Attach the session on its machine, run the messages, show the terminal. */
function go(machineId: string, session: string, messages: ClientMessage[]) {
  if (!openMachineSession(machineId, session, messages)) return;
  useMainTabsStore.getState().showTerminal();
  // The clicked cell goes away with this page. The next keystroke belongs to
  // the terminal. A phone keeps its keyboard down until the terminal is tapped.
  if (!isMobileViewport()) requestAnimationFrame(() => getTerminalHandle()?.focus());
}

/** Open the new session dialog on a machine, switching to it first. */
function newSession(machineId: string) {
  if (
    openWorkspace({ machineId, sessionName: "", tabId: TERMINAL_TAB, messages: [] })
  ) {
    useMachineStore.setState({ createSession: true });
  }
}

/** The attached machine's live state, the part the session tree merges in. */
function useLiveState(): LiveState {
  const machineId = useMachineStore((s) => s.activeMachine);
  const sessions = useSessionStore((s) => s.sessions);
  const sessionsLoaded = useSessionStore((s) => s.sessionsLoaded);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const status = useConnectionStore((s) => s.status);
  const attachedSession = useSessionTreeStore((s) => s.attachedSession);
  const details = useSessionTreeStore((s) => s.details);
  const windows = usePaneStore((s) => s.windows);
  const panes = usePaneStore((s) => s.panes);
  const activeWindowId = usePaneStore((s) => s.activeWindowId);
  const activePaneId = usePaneStore((s) => s.activePaneId);
  const zoomedPaneId = usePaneStore((s) => s.zoomedPaneId);
  const pendingKey = usePaneStore((s) => s.pendingKey);
  return useMemo(
    () => ({
      machineId,
      sessions,
      sessionsLoaded,
      status,
      activeSessionId,
      attachedSession,
      details,
      windows,
      panes,
      activeWindowId,
      activePaneId,
      zoomedPaneId,
      pendingKey,
    }),
    [
      machineId,
      sessions,
      sessionsLoaded,
      status,
      activeSessionId,
      attachedSession,
      details,
      windows,
      panes,
      activeWindowId,
      activePaneId,
      zoomedPaneId,
      pendingKey,
    ],
  );
}

/** Flat gallery of live panes across every machine and session. */
export function OverviewView({ className }: { className?: string }) {
  const machines = useMachineStore((s) => s.machines);
  const loaded = useMachineStore((s) => s.loaded);
  const error = useMachineStore((s) => s.error);
  const inventory = useMachineStore((s) => s.inventory);
  const live = useLiveState();
  const readOnly = useConnectionStore((s) => isReadOnly(s.capabilities));
  const query = useOverviewFilter((s) => s.query);
  const setQuery = useOverviewFilter((s) => s.setQuery);
  const deferredQuery = useDeferredValue(query);
  const inputRef = useRef<HTMLInputElement>(null);
  const [previewSize, setPreviewSize] = useState("20rem");
  const [, refreshLocks] = useState(0);
  useEffect(() => subscribeKeys(() => refreshLocks((value) => value + 1)), []);
  useEffect(() => {
    if (!isMobileViewport()) inputRef.current?.focus({ preventScroll: true });
  }, []);
  const all = useMemo(() => machines.map((machine) => buildMachine(machine, inventory[machine.id], live)), [machines, inventory, live]);
  const panes = useMemo(() => overviewPanes(all, deferredQuery), [all, deferredQuery]);
  const filtering = normalizeQuery(deferredQuery) !== "";
  const first = panes.find((view) => view.machine.connected);
  const available = all.find((view) => view.connected);
  const loading = all.some((view) => view.state === "loading" || view.sessions.some((session) => session.loading));
  const openPane = (view: OverviewPane) => go(view.machine.machine.id, view.session.session.name, [{ type: "pane:select", id: view.pane.id }]);

  return <div style={{ "--preview-size": previewSize } as React.CSSProperties}
    className={cn("@container overflow-y-auto overscroll-contain bg-background font-chrome", className)}>
    <div className="mx-auto w-full max-w-[120rem] px-4 pt-6 pb-16 @lg:px-8 @lg:pt-8">
      <header className="mb-7 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-x-8 gap-y-4">
          <h1 className="text-lg font-semibold text-foreground">Overview</h1>
          <div role="search" className="relative order-last w-full @3xl:order-none @3xl:w-auto @3xl:max-w-md @3xl:flex-1">
            <Search aria-hidden className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input ref={inputRef} type="text" aria-label="Filter panes by machine, session, window, process or folder"
              placeholder="Search terminals" autoComplete="off" autoCapitalize="off" spellCheck={false} enterKeyHint="go"
              value={query} onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape" && query) { event.preventDefault(); setQuery(""); }
                else if (event.key === "Enter" && filtering && first) { event.preventDefault(); openPane(first); }
              }} className="h-10 bg-muted/40 ps-9 pe-10 pointer-coarse:h-11" />
            {query && <button type="button" aria-label="Clear filter" title="Clear filter"
              onClick={() => { setQuery(""); inputRef.current?.focus(); }}
              className="absolute end-1 top-1/2 flex size-8 -translate-y-1/2 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring pointer-coarse:size-9">
              <X className="size-4" aria-hidden />
            </button>}
          </div>
          <PreviewControls size={previewSize} setSize={setPreviewSize} />
        </div>
        <p role="status" className="text-xs text-muted-foreground tabular-nums">
          {loaded ? filtering ? `${plural(panes.length, "pane")} match${panes.length === 1 ? "es" : ""}` : plural(panes.length, "pane") : "Loading terminals…"}
        </p>
      </header>
      {error && !machines.length ? <EmptyState icon={PlugZap} title="Server unavailable" body="Waiting for connection. Retrying automatically." />
        : !loaded ? <Loading label="Loading machines" />
        : !machines.length ? <EmptyState icon={SquareTerminal} title="No machines registered" body="Connected machines appear here." />
        : panes.length ? <ul aria-label="Terminal previews" className="grid items-start gap-x-6 gap-y-8" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, var(--preview-size)), 1fr))" }}>
          {panes.map((view) => <li key={view.key} className="min-w-0">
            <PaneCard view={view} locked={isSessionLocked(view.machine.machine.id, view.session.session.name)} onOpen={() => openPane(view)} />
          </li>)}
        </ul>
        : loading ? <Loading label="Loading panes" />
        : filtering ? <EmptyState icon={Search} title={`No panes match "${deferredQuery.trim()}"`} body="Search by machine, session, window, process or folder."
          action={<Button size="sm" variant="outline" onClick={() => { setQuery(""); inputRef.current?.focus(); }}>Clear filter</Button>} />
        : <EmptyState icon={SquareTerminal} title="No terminals yet" body="Start a session to see its panes here."
          action={!readOnly && available ? <Button size="sm" onClick={() => newSession(available.machine.id)}><Plus aria-hidden className="size-4" />New session</Button> : undefined} />}
      <div className="mt-6 space-y-2 text-xs text-muted-foreground">
        {all.filter((view) => !view.connected || view.sessions.some((session) => session.loading)).map((view) =>
          <p key={view.machine.id}>{view.machine.name}: {view.connected ? "Loading panes…" : machineStatusLabel(view.state, view.connected)}</p>)}
      </div>
    </div>
  </div>;
}

function PaneCard({ view, locked, onOpen }: { view: OverviewPane; locked: boolean; onOpen: () => void }) {
  const { machine, session, window, pane } = view;
  const selected = window.showing && window.focusId === pane.id;
  const title = paneCellText(pane).label;
  const location = `${machine.machine.name} / ${session.session.name} / ${window.window.index}: ${window.window.name} / Pane ${pane.index}`;
  const name = `${paneCellName(pane)}, ${location}${locked ? ", requires unlock" : ""}`;
  return <button type="button" aria-label={`Open ${name}`} aria-current={selected ? "true" : undefined}
    title={name} onClick={onOpen} disabled={!machine.connected}
    className="group block w-full min-w-0 rounded-xl text-start disabled:cursor-wait focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring">
    <div className={cn("rounded-xl", selected && "ring-2 ring-primary ring-offset-2 ring-offset-background")}>
      <LivePreview machineId={machine.machine.id} session={session.session.name} paneId={pane.id}
        supported={machine.machine.features.includes("terminal:preview")} locked={locked} connected={machine.connected} />
    </div>
    <span className="mt-3 flex min-w-0 items-center gap-2 text-sm leading-5 text-foreground">
      <span className="min-w-0 flex-1 truncate font-medium">{title}</span>
      {locked && <Lock aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />}
      {selected && <span className="shrink-0 text-xs text-muted-foreground">Selected</span>}
    </span>
    <span className="mt-0.5 block truncate text-xs leading-5 text-muted-foreground">{location}</span>
  </button>;
}

function EmptyState({
  icon: Icon,
  title,
  body,
  action,
}: {
  icon: React.ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  title: string;
  body: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex max-w-lg flex-col items-start gap-3 rounded-[10px] border border-dashed px-4 py-5">
      <Icon aria-hidden className="h-5 w-5 text-muted-foreground" />
      <div className="space-y-1">
        <p className="text-sm font-medium text-foreground">{title}</p>
        <p className="text-[13px] leading-5 text-muted-foreground text-pretty">{body}</p>
      </div>
      {action}
    </div>
  );
}

function Loading({ label, compact = false }: { label: string; compact?: boolean }) {
  return (
    <p
      role="status"
      className={cn(
        "flex items-center gap-2 text-muted-foreground",
        compact ? "text-xs" : "text-sm",
      )}
    >
      <Loader2 aria-hidden className="h-4 w-4 animate-spin motion-reduce:animate-none" />
      {label}
    </p>
  );
}
