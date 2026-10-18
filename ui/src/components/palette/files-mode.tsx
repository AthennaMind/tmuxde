import { useEffect, useState } from "react";
import { Command } from "cmdk";
import { RepositoryFileIcon } from "@/components/files/repository-file-icon";
import { useQuickOpenQuery } from "@/components/files/use-quick-open-query";
import { useRelayClient } from "@/hooks/use-websocket";
import { isMobileViewport } from "@/lib/mobile-query";
import { filesDisabled, useConnectionStore } from "@/stores/connection-store";
import { useMachineStore } from "@/stores/machine-store";
import { useMainTabsStore } from "@/stores/main-tabs-store";
import { usePaneStore } from "@/stores/pane-store";
import { relativeFile, useQuickOpenStore } from "@/stores/quick-open-store";
import { useSessionTreeStore } from "@/stores/session-tree-store";
import { useUiStore } from "@/stores/ui-store";
import {
  ContextLine,
  GROUP_CLASS,
  LIST_CLASS,
  PaletteEmpty,
  PaletteFooter,
  ROW_CLASS,
} from "./palette-primitives";
import { usePalette } from "./palette-context";

/** Workspace context resets the queries. The typed query lives above. */
export function FilesMode() {
  const machine = useMachineStore((s) => s.activeMachine);
  const pane = usePaneStore((s) => s.activePaneId);
  const folder = usePaneStore((s) => s.panes.find((p) => p.id === s.activePaneId)?.path);
  const attached = useSessionTreeStore((s) => s.attachedSession);
  const attachCount = useSessionTreeStore((s) => s.attachCount);
  const scope = JSON.stringify([machine, pane, folder, attached, attachCount]);
  return (
    <FilesModeContent key={scope} machine={machine} pane={pane} attached={attached !== null} />
  );
}

function FilesModeContent({
  machine,
  pane,
  attached,
}: {
  machine: string;
  pane: string | null;
  attached: boolean;
}) {
  const { query, finish, setBusy } = usePalette();
  const client = useRelayClient();
  const connection = useConnectionStore((s) => s.status);
  const supported = useConnectionStore((s) => s.features.has("repo:search"));
  const disabled = useConnectionStore((s) => filesDisabled(s.capabilities));
  const machineName = useMachineStore(
    (s) => s.machines.find((m) => m.id === machine)?.name ?? machine,
  );
  const recent = useQuickOpenStore((s) => s.recent);
  const [refresh, setRefresh] = useState(0);
  const unavailable = disabled
    ? "File access is off for this connection."
    : connection !== "connected" || !client
      ? "Reconnect to search files."
      : !supported
        ? "Update TmuxDE on this machine to search files."
        : !pane || !attached
          ? "Select a terminal session to search its workspace."
          : null;
  const context = useQuickOpenQuery(
    client,
    !unavailable && pane ? { id: pane, action: "context" } : null,
    refresh,
  );
  const root =
    context.result?.kind === "context" ? (context.result.root ?? context.result.path) : undefined;
  const term = query.trim();
  const search = useQuickOpenQuery(
    client,
    root && pane && term && !unavailable
      ? { id: pane, action: "search", path: root, query: term }
      : null,
    refresh,
    180,
  );
  const result = search.result?.kind === "search" ? search.result : undefined;
  const searchRoot = result?.path ?? root;
  const paths = unavailable
    ? []
    : term
      ? (result?.files ?? [])
      : root
        ? recent
            .filter((file) => file.machineId === machine)
            .map((file) => relativeFile(root, file.path))
            .filter((path): path is string => path !== null)
            .slice(0, 12)
        : [];
  const busy = !unavailable && (context.loading || search.loading);
  const error = context.error ?? search.error;
  const message =
    unavailable ??
    error ??
    (busy && !paths.length
      ? root
        ? "Searching…"
        : "Finding workspace…"
      : paths.length
        ? ""
        : term
          ? result?.truncated
            ? "No matches in scanned files. Narrow the search."
            : `No files match “${term}”.`
          : "Type to find a file. Files you open appear here.");
  const count = paths.length
    ? `${paths.length} ${term ? (paths.length === 1 ? "match" : "matches") : "recent"}${result?.truncated ? " · partial" : ""}`
    : "";

  useEffect(() => {
    setBusy(busy);
    return () => setBusy(false);
  }, [busy, setBusy]);

  const openFile = (relative: string) => {
    if (!pane || !searchRoot || unavailable || busy) return;
    const path = `${searchRoot === "/" ? "" : searchRoot}/${relative}`;
    if (relativeFile(searchRoot, path) === null) return;
    useMainTabsStore.getState().openFile({ paneId: pane, path, machineId: machine });
    if (isMobileViewport()) useUiStore.getState().setMobileTab("terminal");
    finish();
  };

  return (
    <>
      <Command.List className={LIST_CLASS} aria-busy={busy} aria-label="Files">
        {paths.length > 0 && (
          <Command.Group heading={term ? "Files" : "Recent"} className={GROUP_CLASS}>
            {paths.map((path) => {
              const slash = path.lastIndexOf("/");
              return (
                <Command.Item
                  key={path}
                  value={path}
                  onSelect={() => openFile(path)}
                  title={path}
                  className={ROW_CLASS}
                >
                  <span
                    aria-hidden
                    className="flex size-[18px] shrink-0 items-center justify-center [&_svg]:size-[18px]"
                  >
                    <RepositoryFileIcon path={path} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{path.slice(slash + 1)}</span>
                    {slash >= 0 && (
                      <span className="block truncate font-chrome text-xs text-muted-foreground">
                        {path.slice(0, slash)}
                      </span>
                    )}
                  </span>
                </Command.Item>
              );
            })}
          </Command.Group>
        )}
        {message && (
          <PaletteEmpty
            action={
              error ? { label: "Try again", onClick: () => setRefresh((n) => n + 1) } : undefined
            }
          >
            {message}
          </PaletteEmpty>
        )}
      </Command.List>
      <PaletteFooter
        left={<ContextLine parts={[machineName, root, count]} />}
        right={[
          ["↑↓", "move"],
          ["↵", "open"],
          ["esc", "close"],
        ]}
      />
      <div role="status" aria-live="polite" className="sr-only">
        {message || count}
      </div>
    </>
  );
}
