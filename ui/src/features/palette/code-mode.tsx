import { useEffect, useState } from "react";
import { Command } from "cmdk";
import { useRelayClient } from "@/features/connection/use-websocket";
import { filesDisabled, useConnectionStore } from "@/features/connection/connection-store";
import { useMachineStore } from "@/features/connection/machine-store";
import { usePaneStore } from "@/features/panes/pane-store";
import { useSessionTreeStore } from "@/features/session/session-tree-store";
import { useMainTabsStore } from "@/features/workspace/main-tabs-store";
import { useSettingsStore } from "@/features/settings/settings-store";
import { relativeFile } from "@/features/files/quick-open-store";
import { useUiStore } from "@/features/workspace/ui-store";
import { isMobileViewport } from "@/shared/mobile-query";
import { useQuickOpenQuery } from "./use-quick-open-query";
import { usePalette } from "./palette-context";
import {
  ContextLine,
  Highlight,
  LIST_CLASS,
  PaletteEmpty,
  PaletteFooter,
  ROW_CLASS,
} from "./palette-primitives";
import type { RepoResult } from "@/protocol";

type ContentResult = Extract<RepoResult, { kind: "content-search" }>;

export function CodeMode({ caseSensitive }: { caseSensitive: boolean }) {
  const connection = useConnectionStore((s) => s.status);
  const machine = useMachineStore((s) => s.activeMachine);
  const pane = usePaneStore((s) => s.activePaneId);
  const folder = usePaneStore((s) => s.panes.find((p) => p.id === s.activePaneId)?.path);
  const session = useSessionTreeStore((s) => s.attachedSession);
  const attachCount = useSessionTreeStore((s) => s.attachCount);
  return (
    <CodeResults
      key={JSON.stringify([machine, pane, folder, session, attachCount, connection])}
      machine={machine}
      pane={pane}
      session={session}
      caseSensitive={caseSensitive}
    />
  );
}

function CodeResults({
  machine,
  pane,
  session,
  caseSensitive,
}: {
  machine: string;
  pane: string | null;
  session: string | null;
  caseSensitive: boolean;
}) {
  const { query, finish, setBusy } = usePalette();
  const client = useRelayClient();
  const status = useConnectionStore((s) => s.status);
  const supported = useConnectionStore((s) => s.features.has("repo:content-search"));
  const disabled = useConnectionStore((s) => filesDisabled(s.capabilities));
  const machineName = useMachineStore(
    (s) => s.machines.find((m) => m.id === machine)?.name ?? machine,
  );
  const [include, setInclude] = useState("");
  const [exclude, setExclude] = useState("");
  const [refresh, setRefresh] = useState(0);
  const unavailable = disabled
    ? "File access is off for this connection."
    : status !== "connected" || !client
      ? "Reconnect to search repository content."
      : !supported
        ? "Update TmuxDE on this machine to search repository content."
        : !pane || !session
          ? "Select a terminal session to search its repository."
          : null;
  const context = useQuickOpenQuery(
    client,
    !unavailable && pane ? { id: pane, action: "context" } : null,
    refresh,
  );
  const root = context.result?.kind === "context" ? context.result.root : null;
  const invalid = ["\r", "\n", "\0"].some((char) => query.includes(char))
    ? "Enter one line of text."
    : null;
  const search = useQuickOpenQuery(
    client,
    root && pane && query.trim() && !unavailable && !invalid
      ? { id: pane, action: "content-search", path: root, query, include, exclude, caseSensitive }
      : null,
    refresh,
    250,
  );
  const result =
    !unavailable &&
    !invalid &&
    search.result?.kind === "content-search" &&
    search.result.root === root
      ? search.result
      : undefined;
  const busy = !unavailable && (context.loading || search.loading);
  const error = context.error ?? search.error;
  const message =
    unavailable ??
    invalid ??
    error ??
    (context.loading
      ? "Finding repository…"
      : context.result && !root
        ? "This folder is outside a Git repository."
        : !query.trim()
          ? "Find text in files on disk. Unsaved edits are not searched."
          : busy
            ? "Searching…"
            : !result?.matches.length
              ? result?.truncated
                ? "No matches in scanned files. Search is partial. Narrow file filters."
                : "No matching lines."
              : null);
  useEffect(() => {
    setBusy(busy);
    return () => setBusy(false);
  }, [busy, setBusy]);

  const open = (match: ContentResult["matches"][number]) => {
    if (
      !root ||
      !pane ||
      !session ||
      busy ||
      unavailable ||
      client?.status !== "connected" ||
      useMachineStore.getState().activeMachine !== machine
    )
      return;
    const path = `${root === "/" ? "" : root}/${match.path}`;
    if (relativeFile(root, path) === null) return;
    useSettingsStore.getState().setMarkdownPreview(false);
    useMainTabsStore.getState().openFile({
      machineId: machine,
      sessionName: session,
      paneId: pane,
      path,
      position: {
        line: match.line,
        column: match.column,
        endColumn: match.endColumn,
        requestId: crypto.randomUUID(),
      },
    });
    if (isMobileViewport()) useUiStore.getState().setMobileTab("terminal");
    finish("editor");
  };

  return (
    <>
      <div className="grid shrink-0 grid-cols-2 gap-2 border-b px-4 py-2">
        {[
          {
            label: "Include files",
            value: include,
            change: setInclude,
            placeholder: "*.go, src/**",
          },
          {
            label: "Exclude files",
            value: exclude,
            change: setExclude,
            placeholder: "vendor/**, *.test.*",
          },
        ].map((filter) => (
          <label key={filter.label} className="min-w-0 text-xs text-muted-foreground">
            {filter.label}
            <input
              value={filter.value}
              onChange={(event) => filter.change(event.target.value)}
              onKeyDown={(event) => {
                if (["Enter", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key))
                  event.stopPropagation();
              }}
              placeholder={filter.placeholder}
              maxLength={512}
              autoComplete="off"
              spellCheck={false}
              className="mt-1 min-h-11 w-full rounded-md border bg-background px-2 text-sm text-foreground focus-visible:outline-2 focus-visible:outline-ring"
            />
          </label>
        ))}
        <p className="col-span-2 text-xs text-muted-foreground">
          Comma-separated patterns. * matches names. ** includes folders. Untracked files follow Git
          ignore rules.
        </p>
      </div>
      <Command.List className={LIST_CLASS} aria-busy={busy} aria-label="Repository matches">
        {!message &&
          result?.matches.map((match) => (
            <Command.Item
              key={`${match.path}:${match.line}`}
              value={`${match.path}:${match.line}`}
              onSelect={() => open(match)}
              className={ROW_CLASS}
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs text-muted-foreground" title={match.path}>
                  {match.path}:{match.line}
                </span>
                <span className="block truncate whitespace-pre font-mono text-sm">
                  <Highlight text={match.preview} ranges={[[match.matchStart, match.matchEnd]]} />
                </span>
              </span>
            </Command.Item>
          ))}
        {message && (
          <PaletteEmpty
            action={
              error ? { label: "Try again", onClick: () => setRefresh((n) => n + 1) } : undefined
            }
          >
            {message}
          </PaletteEmpty>
        )}
        {result?.truncated && !!result.matches.length && (
          <p role="status" className="px-3 py-2 text-xs text-muted-foreground">
            Partial results. Scan limits or skipped files left content unsearched. Narrow file
            filters.
          </p>
        )}
      </Command.List>
      <PaletteFooter
        left={
          <ContextLine
            parts={[machineName, root, result ? `${result.matches.length} matching lines` : null]}
          />
        }
        right={[
          ["↑↓", "move"],
          ["↵", "open"],
        ]}
      />
      <div role="status" className="sr-only">
        {message ??
          (result
            ? `${result.matches.length} matching lines${result.truncated ? ", partial results" : ""}`
            : "")}
      </div>
    </>
  );
}
