import { useDeferredValue, useEffect, useId, useMemo, useRef, useState } from "react";
import { create } from "zustand";
import {
  Loader2,
  Lock,
  Maximize2,
  Monitor,
  Plus,
  PlugZap,
  RefreshCw,
  Search,
  SquareTerminal,
  X,
} from "lucide-react";
import type { ClientMessage } from "@/protocol";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PaneGrid } from "@/components/sidebar/pane-grid";
import { getTerminalHandle } from "@/components/terminal/terminal-handle";
import { isSessionLocked } from "@/lib/lock-store";
import { isMobileViewport } from "@/lib/mobile-query";
import { get as getClient } from "@/lib/relay-registry";
import { cn } from "@/lib/utils";
import { openMachineSession, openWorkspace } from "@/lib/workspace-target";
import { isReadOnly, useConnectionStore } from "@/stores/connection-store";
import { useMachineStore } from "@/stores/machine-store";
import { TERMINAL_TAB, useMainTabsStore } from "@/stores/main-tabs-store";
import { usePaneStore } from "@/stores/pane-store";
import { useSessionStore } from "@/stores/session-store";
import { useSessionTreeStore } from "@/stores/session-tree-store";
import { useSettingsStore } from "@/stores/settings-store";
import {
  activityLabel,
  buildMachine,
  filterOverview,
  machineStatusLabel,
  normalizeQuery,
  plural,
  windowCardName,
  type LiveState,
  type OverviewMachine,
  type OverviewSession,
  type OverviewWindow,
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

/**
 * Every window of every machine as a card, like tmux `choose-tree`.
 *
 * A main area tab that reads every machine, so it lives outside the machine
 * scoped views and survives a machine switch. Each card draws the window's
 * panes as a grid. A click on a cell or on the card header goes there.
 */
export function OverviewView({ className }: { className?: string }) {
  const machines = useMachineStore((s) => s.machines);
  const loaded = useMachineStore((s) => s.loaded);
  const error = useMachineStore((s) => s.error);
  const inventory = useMachineStore((s) => s.inventory);
  const live = useLiveState();
  const showIndex = useSettingsStore((s) => s.showPaneIndexes);
  const readOnly = useConnectionStore((s) => isReadOnly(s.capabilities));
  const query = useOverviewFilter((s) => s.query);
  const setQuery = useOverviewFilter((s) => s.setQuery);
  const deferredQuery = useDeferredValue(query);
  const inputRef = useRef<HTMLInputElement>(null);
  const [, setTick] = useState(0);

  // Relative times read "now", "4m", "2h". A minute tick keeps them honest.
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 60_000);
    return () => clearInterval(id);
  }, []);

  // Opened from the rail, the palette or the shortcut, typing filters at
  // once. Not on a phone, where focus would raise the keyboard over the list.
  useEffect(() => {
    if (!isMobileViewport()) inputRef.current?.focus({ preventScroll: true });
  }, []);

  const all = useMemo(
    () => machines.map((machine) => buildMachine(machine, inventory[machine.id], live)),
    [machines, inventory, live],
  );
  const filtered = useMemo(() => filterOverview(all, deferredQuery), [all, deferredQuery]);
  const filtering = normalizeQuery(deferredQuery) !== "";

  const totals = all.reduce(
    (sum, machine) => ({
      sessions: sum.sessions + machine.sessionCount,
      windows:
        sum.windows +
        machine.sessions.reduce((count, session) => count + session.windowCount, 0),
    }),
    { sessions: 0, windows: 0 },
  );
  const summary = filtering
    ? filtered.windows === 0
      ? "No windows match"
      : `${filtered.windows === 1 ? "1 window matches" : `${filtered.windows} windows match`}.${filtered.first ? " Enter opens the first." : ""}`
    : loaded && machines.length
      ? [
          plural(machines.length, "machine"),
          plural(totals.sessions, "session"),
          plural(totals.windows, "window"),
        ].join(", ")
      : "";

  return (
    <div
      className={cn(
        "@container overflow-y-auto overscroll-contain bg-background font-chrome",
        className,
      )}
    >
      <div className="mx-auto w-full max-w-[120rem] space-y-10 px-4 pt-6 pb-16 @lg:px-8 @lg:pt-8">
        <header className="space-y-3">
          <h1 className="text-lg font-semibold text-foreground">Overview</h1>
          <div role="search" className="relative max-w-lg">
            <Search
              aria-hidden
              className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              ref={inputRef}
              type="text"
              aria-label="Filter sessions, windows, processes and folders"
              placeholder="Name, process or folder"
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              enterKeyHint="go"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape" && query) {
                  event.preventDefault();
                  setQuery("");
                } else if (event.key === "Enter" && filtering && filtered.first) {
                  event.preventDefault();
                  const { machine, session, window } = filtered.first;
                  go(machine.machine.id, session.session.name, [
                    { type: "window:select", id: window.window.id },
                  ]);
                }
              }}
              className="h-9 ps-9 pe-10 pointer-coarse:h-11"
            />
            {query && (
              <button
                type="button"
                aria-label="Clear filter"
                title="Clear filter"
                onClick={() => {
                  setQuery("");
                  inputRef.current?.focus();
                }}
                className="absolute end-1 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring pointer-coarse:h-9 pointer-coarse:w-9"
              >
                <X className="h-4 w-4" aria-hidden />
              </button>
            )}
          </div>
          {/* One line that is the page summary at rest and the match count
              while filtering. A live region, so the count is read out. */}
          <p role="status" className="min-h-5 text-xs leading-5 text-muted-foreground tabular-nums">
            {summary}
          </p>
        </header>

        {error && !machines.length ? (
          <EmptyState
            icon={PlugZap}
            title="Server unavailable"
            body="Machines show here once the server answers. It is asked again every 5 seconds."
          />
        ) : !loaded ? (
          <Loading label="Loading machines" />
        ) : !machines.length ? (
          <EmptyState
            icon={SquareTerminal}
            title="No machines registered"
            body="Machines show here as soon as they connect to this server."
          />
        ) : filtering && !filtered.machines.length ? (
          <EmptyState
            icon={Search}
            title={`No windows match "${deferredQuery.trim()}"`}
            body="The filter looks at session names, window names, processes and folders."
            action={
              <Button
                size="sm"
                variant="outline"
                className="pointer-coarse:h-11"
                onClick={() => {
                  setQuery("");
                  inputRef.current?.focus();
                }}
              >
                Clear filter
              </Button>
            }
          />
        ) : (
          filtered.machines.map((machine) => (
            <MachineSection
              key={machine.machine.id}
              view={machine}
              total={all.find((m) => m.machine.id === machine.machine.id)?.sessionCount ?? 0}
              filtering={filtering}
              live={live}
              showIndex={showIndex}
              readOnly={readOnly}
            />
          ))
        )}
      </div>
    </div>
  );
}

function MachineSection({
  view,
  total,
  filtering,
  live,
  showIndex,
  readOnly,
}: {
  view: OverviewMachine;
  /** Sessions before the filter. */
  total: number;
  filtering: boolean;
  live: LiveState;
  showIndex: boolean;
  readOnly: boolean;
}) {
  const headingId = useId();
  const { machine, state } = view;
  const online = state === "ready" && view.connected;
  const status = machineStatusLabel(state, view.connected);

  return (
    <section aria-labelledby={headingId} className="space-y-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h2
          id={headingId}
          className="flex min-w-0 items-center gap-2 text-sm font-semibold text-foreground"
          title={machine.hostname !== machine.name ? `${machine.name}, ${machine.hostname}` : machine.name}
        >
          <span className="min-w-0 truncate">{machine.name}</span>
          {machine.id === "local" && (
            <span className="shrink-0 rounded bg-muted px-1.5 text-[11px] font-normal leading-5 text-muted-foreground">
              Local
            </span>
          )}
        </h2>
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span
            aria-hidden
            className={cn(
              "h-1.5 w-1.5 rounded-full",
              online ? "bg-primary" : "bg-muted-foreground/50",
            )}
          />
          {status}
        </span>
        {state === "ready" && (
          <span className="text-xs tabular-nums text-muted-foreground">
            {filtering
              ? `${view.sessions.length} of ${plural(total, "session")}`
              : plural(total, "session")}
          </span>
        )}
      </div>

      {state === "offline" ? (
        <EmptyState
          icon={PlugZap}
          title="Machine offline"
          body="Its sessions keep running in tmux and show here when it is back."
        />
      ) : state === "unreachable" ? (
        <EmptyState
          icon={PlugZap}
          title="Can't reach this machine"
          body="Sessions keep running in tmux while the connection is down."
          action={
            <Button
              size="sm"
              variant="outline"
              className="pointer-coarse:h-11"
              onClick={() => getClient(`inventory:${machine.id}`)?.connect()}
            >
              <RefreshCw className="h-3.5 w-3.5" aria-hidden />
              Try again
            </Button>
          }
        />
      ) : state === "loading" ? (
        <Loading label="Loading sessions" />
      ) : !view.sessions.length ? (
        <EmptyState
          icon={SquareTerminal}
          title="No sessions yet"
          body="Create one to start a shell on this machine."
          action={
            readOnly ? undefined : (
              <Button
                size="sm"
                className="pointer-coarse:h-11"
                disabled={!view.connected}
                onClick={() => newSession(machine.id)}
              >
                <Plus className="h-3.5 w-3.5" aria-hidden />
                New session
              </Button>
            )
          }
        />
      ) : (
        // Sessions flow side by side while they fit, so a machine with many
        // small sessions stays short. A session with more windows than a
        // row holds takes the full width and wraps its cards.
        <div className="flex flex-wrap items-start gap-x-8 gap-y-8">
          {view.sessions.map((session) => (
            <SessionGroup
              key={session.session.name}
              machine={view}
              session={session}
              filtering={filtering}
              current={live.machineId === machine.id && live.activeSessionId === session.session.name}
              showIndex={showIndex}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function SessionGroup({
  machine,
  session,
  filtering,
  current,
  showIndex,
}: {
  machine: OverviewMachine;
  session: OverviewSession;
  filtering: boolean;
  /** The session the terminal shows, or is switching to. */
  current: boolean;
  showIndex: boolean;
}) {
  const headingId = useId();
  const name = session.session.name;
  const shown = session.windows.length;
  const locked = isSessionLocked(machine.machine.id, name);

  return (
    // Full width below @md, so the cards inside fill the phone. Content wide
    // above it, so sessions flow side by side.
    <section aria-labelledby={headingId} className="w-full min-w-0 max-w-full space-y-2 @md:w-auto">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
        <h3 id={headingId} className="min-w-0 truncate text-[13px] font-medium text-foreground">
          {name}
        </h3>
        <span className="text-xs tabular-nums text-muted-foreground">
          {filtering && shown < session.windowCount
            ? `${shown} of ${plural(session.windowCount, "window")}`
            : plural(session.windowCount, "window")}
        </span>
        <span className="text-xs text-muted-foreground">
          {activityLabel(session.session.activity)}
        </span>
        {locked && (
          <Lock
            role="img"
            aria-label="Requires unlock"
            className="h-3 w-3 text-muted-foreground"
          />
        )}
        {!current && session.session.attached && (
          <Monitor
            role="img"
            aria-label="Open in another client"
            className="h-3 w-3 text-muted-foreground"
          />
        )}
      </div>
      {session.loading ? (
        <Loading label="Loading windows" compact />
      ) : !shown ? (
        <p className="text-xs text-muted-foreground">No windows</p>
      ) : (
        // Cards are 240px, one full width column on a phone.
        <ul role="list" className="flex flex-wrap items-stretch gap-3">
          {session.windows.map((window) => (
            <li key={window.window.id} className="w-full min-w-0 @md:w-60">
              <WindowCard
                machineId={machine.machine.id}
                session={name}
                window={window}
                showIndex={showIndex}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function WindowCard({
  machineId,
  session,
  window: view,
  showIndex,
}: {
  machineId: string;
  session: string;
  window: OverviewWindow;
  showIndex: boolean;
}) {
  const { window, panes } = view;
  const name = windowCardName(view);
  const newOutput = !!window.activity && !view.showing;

  return (
    // 10px outside, 6px of padding, 4px on the header and the cells inside.
    <div
      className={cn(
        "flex h-full flex-col gap-1.5 rounded-[10px] border bg-card p-1.5",
        view.showing && "border-primary",
      )}
    >
      <button
        type="button"
        aria-label={name}
        aria-current={view.showing ? "true" : undefined}
        title={[`${window.index}: ${window.name}`, view.detail].filter(Boolean).join(", ")}
        onClick={() => go(machineId, session, [{ type: "window:select", id: window.id }])}
        className="flex min-h-11 w-full min-w-0 touch-manipulation flex-col justify-center rounded-[4px] px-1.5 py-1 text-start transition-colors duration-150 hover:bg-foreground/5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        <span className="flex w-full min-w-0 items-center gap-2 text-[13px] leading-5">
          <span className="shrink-0 tabular-nums text-muted-foreground">{window.index}</span>
          <span className="min-w-0 flex-1 truncate font-medium text-foreground">
            {view.label}
          </span>
          {view.zoomed && (
            <Maximize2 aria-hidden className="h-3 w-3 shrink-0 text-muted-foreground" />
          )}
          {newOutput && (
            <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
          )}
        </span>
        {/* Kept when empty, so every card has the same shape. */}
        <span className="min-h-4 w-full truncate text-xs leading-4 text-muted-foreground">
          {view.detail}
        </span>
      </button>
      {panes.length ? (
        <PaneGrid
          size="card"
          layout={window.layout}
          panes={panes}
          dimensions={window.dimensions}
          focusId={view.focusId}
          zoomedId={view.zoomedId}
          active={view.showing}
          pendingId={view.pendingId}
          showIndex={showIndex}
          label={`Panes of window ${window.index} ${view.label}`}
          onSelect={(pane) => go(machineId, session, [{ type: "pane:select", id: pane.id }])}
        />
      ) : (
        <div aria-hidden className="aspect-[2/1] max-h-32 min-h-14 rounded-[4px] bg-foreground/10" />
      )}
    </div>
  );
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
