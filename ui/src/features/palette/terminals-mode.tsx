import { useEffect, useState } from "react";
import { Command } from "cmdk";
import type { TerminalSearchMatch } from "@/protocol";
import { isSessionLocked } from "@/features/lock/lock-store";
import { openMachineSession } from "@/features/workspace/workspace-target";
import { useMachineStore } from "@/features/connection/machine-store";
import { useTerminalSearchStore, type MachineSearch } from "./terminal-search-store";
import { GROUP_CLASS, LIST_CLASS, PaletteEmpty, PaletteFooter } from "./palette-primitives";
import { usePalette } from "./palette-context";

/** Results stay in the store, so reopening shows the last search. */
export function TerminalsMode({ caseSensitive }: { caseSensitive: boolean }) {
  const { query, finish, setBusy } = usePalette();
  const state = useTerminalSearchStore();
  const loaded = useMachineStore((s) => s.loaded);
  const machineCount = useMachineStore((s) => s.machines.length);
  const [navigationError, setNavigationError] = useState("");
  const busy = state.machines.some((machine) => machine.state === "searching");
  const count = state.machines.reduce(
    (sum, machine) => sum + (machine.result?.matches.length ?? 0),
    0,
  );
  const completed = state.machines.filter((machine) => machine.state === "done").length;
  const partial = state.machines.some(
    (machine) => machine.state !== "done" || machine.result?.partial,
  );
  const stale = !state.requestId || query !== state.query || caseSensitive !== state.caseSensitive;

  useEffect(() => setNavigationError(""), [state.requestId]);
  useEffect(() => {
    setBusy(busy);
    return () => setBusy(false);
  }, [busy, setBusy]);

  const openPane = (machineId: string, match: TerminalSearchMatch) => {
    if (
      openMachineSession(machineId, match.sessionName, [{ type: "pane:select", id: match.paneId }])
    )
      finish("terminal");
    else setNavigationError("Could not open the pane. Check the machine connection and try again.");
  };

  const status = !loaded
    ? "Loading machines…"
    : !machineCount
      ? "No machines"
      : !state.requestId
        ? ""
        : busy
          ? `${count} so far`
          : `${count} ${count === 1 ? "match" : "matches"} · ${completed} of ${state.machines.length} machines${partial ? " · partial" : ""}`;
  const empty = !loaded
    ? "Loading machines…"
    : !machineCount
      ? "No machines are registered."
      : !state.requestId
        ? "Search tmux history on every machine. Press Enter to search."
        : !busy && count === 0
          ? `No matches for “${state.query}”.`
          : "";

  return (
    <>
      <Command.List className={LIST_CLASS} aria-busy={busy} aria-label="Terminal matches">
        {navigationError && (
          <p role="alert" className="px-3 pt-3 text-sm text-destructive">
            {navigationError}
          </p>
        )}
        {empty && <PaletteEmpty>{empty}</PaletteEmpty>}
        {state.machines.map((machine) => (
          <MachineResults
            key={machine.id}
            machine={machine}
            query={state.query}
            caseSensitive={state.caseSensitive}
            openPane={openPane}
          />
        ))}
      </Command.List>
      <PaletteFooter
        left={
          <span className="truncate">
            {stale && state.requestId ? `Results for “${state.query}”` : status}
          </span>
        }
        right={
          stale && query.trim()
            ? [
                ["↵", "search"],
                ["esc", "close"],
              ]
            : [
                ["↑↓", "move"],
                ["↵", "open pane"],
                ["esc", "close"],
              ]
        }
      />
      <div role="status" aria-live="polite" className="sr-only">
        {status}
      </div>
    </>
  );
}

function machineNote(machine: MachineSearch, matches: number): string {
  switch (machine.state) {
    case "searching":
      return "Searching…";
    case "offline":
      return "Offline";
    case "unsupported":
      return "Needs update";
    case "error":
      return machine.error ?? "Failed";
    default: {
      const panes = machine.result?.searchedPanes ?? 0;
      const parts = [
        matches ? `${matches} in ${panes} ${panes === 1 ? "pane" : "panes"}` : "No matches",
      ];
      if (machine.result?.partial) parts.push("partial");
      if (machine.excluded > 0) parts.push(`${machine.excluded} locked`);
      return parts.join(" · ");
    }
  }
}

function MachineResults({
  machine,
  query,
  caseSensitive,
  openPane,
}: {
  machine: MachineSearch;
  query: string;
  caseSensitive: boolean;
  openPane: (machineId: string, match: TerminalSearchMatch) => void;
}) {
  const groups = new Map<string, TerminalSearchMatch[]>();
  for (const match of machine.result?.matches ?? []) {
    if (isSessionLocked(machine.id, match.sessionName)) continue;
    const group = groups.get(match.paneId) ?? [];
    group.push(match);
    groups.set(match.paneId, group);
  }
  const matches = [...groups.values()].reduce((sum, list) => sum + list.length, 0);
  const heading = (
    <span className="flex items-center justify-between gap-3 normal-case tracking-normal">
      <span className="truncate font-chrome text-xs">{machine.name}</span>
      <span className="shrink-0 font-normal tabular-nums">{machineNote(machine, matches)}</span>
    </span>
  );
  if (!matches) {
    return (
      <div role="presentation" className={GROUP_CLASS}>
        <div cmdk-group-heading="">{heading}</div>
      </div>
    );
  }
  return (
    <Command.Group heading={heading} className={GROUP_CLASS}>
      {[...groups.entries()].map(([paneId, list]) => {
        const source = list[0]!;
        return (
          <div key={paneId} role="presentation">
            <div className="flex min-w-0 items-baseline gap-2 px-3 pb-1 pt-2 text-xs">
              <span className="shrink-0 font-chrome font-medium text-foreground">
                {source.sessionName}
              </span>
              <span className="truncate font-chrome text-muted-foreground">
                {source.windowId} · {source.command || "shell"}
                {source.path ? ` · ${source.path}` : ""}
              </span>
            </div>
            {list.map((match) => (
              <Command.Item
                key={match.line}
                value={`${machine.id}|${paneId}|${match.line}`}
                onSelect={() => openPane(machine.id, match)}
                aria-label={`${source.sessionName}, pane ${paneId}: ${match.text}`}
                className="group cursor-pointer select-none rounded-[0.875rem] px-3 py-2 outline-none data-[selected=true]:bg-accent"
              >
                <div className="whitespace-pre-wrap break-all font-mono text-xs leading-5">
                  {match.before && <div className="text-muted-foreground">{match.before}</div>}
                  <div className="text-foreground">
                    <Highlight text={match.text} query={query} caseSensitive={caseSensitive} />
                  </div>
                  {match.after && <div className="text-muted-foreground">{match.after}</div>}
                </div>
              </Command.Item>
            ))}
          </div>
        );
      })}
    </Command.Group>
  );
}

function Highlight({
  text,
  query,
  caseSensitive,
}: {
  text: string;
  query: string;
  caseSensitive: boolean;
}) {
  if (!query) return text;
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const parts = text.split(new RegExp(`(${escaped})`, caseSensitive ? "gu" : "giu"));
  return parts.map((part, index) =>
    index % 2 ? (
      <mark key={index} className="rounded-sm bg-primary/20 text-foreground">
        {part}
      </mark>
    ) : (
      part
    ),
  );
}
