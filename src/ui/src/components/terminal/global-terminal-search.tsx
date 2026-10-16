import { useEffect, useRef, useState, type RefObject } from "react";
import { Loader2, Search, X } from "lucide-react";
import {
  Dialog, DialogClose, DialogContentRaw, DialogDescription,
  DialogOverlay, DialogPortal, DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { TerminalSearchMatch } from "@/protocol";
import { openMachineSession } from "@/lib/workspace-target";
import { isSessionLocked } from "@/lib/lock-store";
import { isMobileViewport } from "@/lib/mobile-query";
import { getTerminalHandle } from "./terminal-handle";
import { useMachineStore } from "@/stores/machine-store";
import {
  searchTerminals, useTerminalSearchStore, type MachineSearch,
} from "@/stores/terminal-search-store";

export function GlobalTerminalSearch() {
  const open = useTerminalSearchStore((s) => s.open);
  const inputRef = useRef<HTMLInputElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const navigated = useRef(false);
  return (
    <Dialog open={open} onOpenChange={(open) => useTerminalSearchStore.setState({ open })}>
      <DialogPortal>
        <DialogOverlay />
        <DialogContentRaw
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
            navigated.current = false;
            inputRef.current?.focus();
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (navigated.current) {
              if (!isMobileViewport()) getTerminalHandle()?.focus();
            } else if (returnFocus.current?.isConnected) {
              returnFocus.current.focus();
            }
          }}
          className="fixed inset-x-0 z-[var(--z-modal)] mx-auto flex w-full max-w-4xl flex-col overflow-hidden border bg-background shadow-lg sm:rounded-lg"
          style={{ top: "var(--vv-offset-top, 0px)", maxHeight: "var(--vv-height, 100dvh)" }}
        >
          <SearchContents inputRef={inputRef} onNavigate={() => { navigated.current = true; }} />
        </DialogContentRaw>
      </DialogPortal>
    </Dialog>
  );
}

function SearchContents({ inputRef, onNavigate }: {
  inputRef: RefObject<HTMLInputElement | null>;
  onNavigate: () => void;
}) {
  const state = useTerminalSearchStore();
  const loaded = useMachineStore((s) => s.loaded);
  const machineCount = useMachineStore((s) => s.machines.length);
  const [query, setQuery] = useState(state.query);
  const [caseSensitive, setCaseSensitive] = useState(state.caseSensitive);
  const [navigationError, setNavigationError] = useState("");
  const busy = state.machines.some((machine) => machine.state === "searching");
  const count = state.machines.reduce((sum, machine) => sum + (machine.result?.matches.length ?? 0), 0);
  const completed = state.machines.filter((machine) => machine.state === "done").length;
  const incomplete = state.machines.some((machine) => machine.state !== "done" || machine.result?.partial);
  const changed = query !== state.query || caseSensitive !== state.caseSensitive;

  useEffect(() => {
    setNavigationError("");
  }, [state.requestId]);

  const openPane = (machineId: string, match: TerminalSearchMatch) => {
    if (openMachineSession(machineId, match.sessionName, [{ type: "pane:select", id: match.paneId }])) {
      onNavigate();
      useTerminalSearchStore.setState({ open: false });
      if (!isMobileViewport()) requestAnimationFrame(() => getTerminalHandle()?.focus());
    } else {
      setNavigationError("Could not open pane. Check machine connection and try again.");
    }
  };

  return (
    <>
      <header className="flex shrink-0 items-start justify-between gap-4 border-b p-4 sm:px-6">
        <div className="space-y-2">
          <DialogTitle>Search all terminals</DialogTitle>
          <DialogDescription>
            Search retained tmux history across machines. Closed panes and locked sessions are excluded.
          </DialogDescription>
        </div>
        <DialogClose asChild>
          <Button variant="ghost" size="icon" className="h-11 w-11 shrink-0" aria-label="Close terminal search">
            <X className="h-4 w-4" aria-hidden />
          </Button>
        </DialogClose>
      </header>
      <form
        className="shrink-0 space-y-3 border-b p-4 sm:px-6"
        onSubmit={(event) => { event.preventDefault(); searchTerminals(query, caseSensitive); }}
      >
        <div className="flex gap-2">
          <Input
            ref={inputRef}
            aria-label="Search terminal history"
            placeholder="Error, command or output"
            value={query}
            maxLength={256}
            onChange={(event) => setQuery(event.target.value)}
            autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
            enterKeyHint="search" className="h-11 min-w-0 flex-1"
          />
          <Button type="submit" className="h-11" disabled={busy || !loaded || !machineCount || !query.trim()}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden /> : <Search className="h-4 w-4" aria-hidden />}
            Search
          </Button>
        </div>
        <label className="flex min-h-8 w-fit items-center gap-2 text-sm">
          <input type="checkbox" checked={caseSensitive} onChange={(event) => setCaseSensitive(event.target.checked)} className="h-4 w-4 accent-primary" />
          Match case
        </label>
        <p role="status" className="text-sm text-muted-foreground">
          {!loaded ? "Loading machines"
            : !machineCount ? "No machines registered"
            : !state.requestId ? "Enter text and press Search. Matches include nearby lines."
            : busy ? `Searching machines. ${count} matches so far.`
            : `${count} ${count === 1 ? "match" : "matches"}. ${completed} of ${state.machines.length} machines searched.${incomplete ? " Some history could not be searched. See details below." : ""}`}
        </p>
        {state.requestId && changed && <p className="text-sm text-muted-foreground">Showing results for “{state.query}”. Press Search to update.</p>}
        {navigationError && <p role="alert" className="text-sm text-destructive">{navigationError}</p>}
      </form>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4 sm:px-6" aria-label="Terminal search results" aria-busy={busy}>
        <div className="space-y-6">
          {state.machines.map((machine) => (
            <MachineResults key={machine.id} machine={machine} query={state.query} caseSensitive={state.caseSensitive} openPane={openPane} />
          ))}
        </div>
      </div>
    </>
  );
}

function MachineResults({ machine, query, caseSensitive, openPane }: {
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
  const panes = machine.result?.searchedPanes ?? 0;
  const note = machine.state === "searching" ? "Searching"
    : machine.state === "offline" ? "Offline. History was not searched."
    : machine.state === "unsupported" ? "Update tmuxde on this machine to search its history."
    : machine.state === "error" ? machine.error
    : `${panes} ${panes === 1 ? "pane" : "panes"} searched${groups.size ? "" : ". No matches"}.`;
  return (
    <section className="space-y-3" aria-label={machine.name}>
      <div>
        <h2 className="text-sm font-semibold">{machine.name}</h2>
        <p className="text-sm text-muted-foreground">{note}</p>
        {machine.excluded > 0 && <p className="text-sm text-muted-foreground">{machine.excluded} locked {machine.excluded === 1 ? "session" : "sessions"} excluded.</p>}
        {machine.result?.partial && <p className="text-sm text-muted-foreground">Partial results. Search reached its time, history or result limit, or a pane became unavailable. Refine search to see fewer matches.</p>}
      </div>
      {[...groups.entries()].map(([paneId, matches]) => {
        const source = matches[0]!;
        return (
          <div key={paneId} className="overflow-hidden rounded-lg border">
            <div className="space-y-1 border-b bg-muted/40 px-3 py-2">
              <p className="break-words text-sm font-medium">{source.sessionName} / {source.windowId} / {paneId} · {source.command || "Terminal"}</p>
              {source.path && <p className="break-all text-xs text-muted-foreground">{source.path}</p>}
            </div>
            <ul className="divide-y">
              {matches.map((match) => (
                <li key={match.line}>
                  <button
                    type="button"
                    onClick={() => openPane(machine.id, match)}
                    aria-label={`Open ${source.sessionName}, pane ${paneId}, match: ${match.text}`}
                    className="block min-h-11 w-full px-3 py-3 text-start hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                  >
                    <div className="whitespace-pre-wrap break-all font-mono text-xs leading-5">
                      {match.before && <div className="text-muted-foreground">{match.before}</div>}
                      <div><Highlight text={match.text} query={query} caseSensitive={caseSensitive} /></div>
                      {match.after && <div className="text-muted-foreground">{match.after}</div>}
                    </div>
                    <span className="mt-2 block text-xs text-muted-foreground">Open pane</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </section>
  );
}

function Highlight({ text, query, caseSensitive }: { text: string; query: string; caseSensitive: boolean }) {
  if (!query) return text;
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const parts = text.split(new RegExp(`(${escaped})`, caseSensitive ? "gu" : "giu"));
  return parts.map((part, index) => index % 2
    ? <mark key={index} className="rounded-sm bg-primary/20 text-foreground">{part}</mark>
    : part);
}
