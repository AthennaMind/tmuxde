import { useEffect, useCallback } from "react";
import {
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandSeparator,
  CommandShortcut,
} from "@/components/ui/command";
import {
  Terminal,
  XCircle,
  Send,
  Trash2,
  Pause,
  History,
  Bookmark,
  PlugZap,
  SlidersHorizontal,
  TextSearch,
  GitGraph,
  LayoutGrid,
} from "lucide-react";
import { useCommandStore } from "@/stores/command-store";
import { useUiStore } from "@/stores/ui-store";
import { useMainTabsStore } from "@/stores/main-tabs-store";
import { isMobileViewport } from "@/lib/mobile-query";
import { getRelayClient, useRelayClient } from "@/hooks/use-websocket";
import { sendCommand } from "@/lib/send-command";
import { useConnectionStore } from "@/stores/connection-store";
import { usePaneStore } from "@/stores/pane-store";
import { useRepositoryQuery } from "@/components/files/repository-preview";
import type { RepositoryClient } from "@/components/files/repository-request";

export function CommandPalette() {
  const { paletteOpen, setPaletteOpen, history, snippets } = useCommandStore();

  // Cmd+K / Ctrl+K trigger
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setPaletteOpen(!paletteOpen);
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [paletteOpen, setPaletteOpen]);

  const executeCommand = useCallback(
    (cmd: string) => {
      // `sendCommand` records it; this used to do both itself, which is how
      // the mobile bar came to be the one send path that forgot to.
      if (!sendCommand(cmd)) return;
      setPaletteOpen(false);
    },
    [setPaletteOpen],
  );

  const sendQuickAction = useCallback(
    (action: string) => {
      const client = getRelayClient();
      if (!client) return;

      switch (action) {
        case "interrupt":
          client.send({ type: "command:interrupt" });
          break;
        case "eof":
          client.send({ type: "command:eof" });
          break;
        case "clear":
          client.send({ type: "command:clear" });
          break;
        case "suspend":
          client.send({ type: "command:suspend" });
          break;
      }
      setPaletteOpen(false);
    },
    [setPaletteOpen],
  );

  const handleSelect = useCallback(
    (value: string) => {
      if (value === "open:search") {
        setPaletteOpen(false);
        useUiStore.getState().setTerminalSearchOpen(true);
      } else if (value === "open:settings") {
        // A tab on desktop, the Settings tab on a phone. No route of its own.
        setPaletteOpen(false);
        if (isMobileViewport()) useUiStore.getState().setMobileTab("settings");
        else useMainTabsStore.getState().openSettings();
      } else if (value === "open:overview") {
        // A main-area tab on both layouts. A phone shows it where the
        // terminal is.
        setPaletteOpen(false);
        useMainTabsStore.getState().openOverview();
        if (isMobileViewport()) useUiStore.getState().setMobileTab("terminal");
      } else if (value.startsWith("goto:")) {
        // A real navigation, not `router.push`: these leave the terminal group
        // entirely, and the palette's own open state is the only thing worth
        // preserving across the boundary — which is to say, nothing.
        setPaletteOpen(false);
        window.location.assign(value.replace("goto:", ""));
      } else if (value.startsWith("action:")) {
        sendQuickAction(value.replace("action:", ""));
      } else if (value.startsWith("history:") || value.startsWith("snippet:")) {
        const cmd = value.split(":").slice(1).join(":");
        executeCommand(cmd);
      } else {
        // Direct command input
        executeCommand(value);
      }
    },
    [executeCommand, sendQuickAction, setPaletteOpen],
  );

  const pinnedSnippets = snippets.filter((s) => s.pinned);
  const otherSnippets = snippets.filter((s) => !s.pinned);

  return (
    <CommandDialog open={paletteOpen} onOpenChange={setPaletteOpen}>
      <CommandInput placeholder="Type a command or search..." />
      <CommandList>
        <CommandEmpty>Press Enter to execute as shell command</CommandEmpty>

        <CommandGroup heading="Quick Actions">
          {/* Desktop has no terminal bar, so search opens from here. */}
          <CommandItem value="open:search" onSelect={handleSelect}>
            <TextSearch className="h-4 w-4" />
            Search terminal
          </CommandItem>
          <CommandItem value="action:interrupt" onSelect={handleSelect}>
            <XCircle className="h-4 w-4 text-destructive" />
            Interrupt (Ctrl+C)
            <CommandShortcut>^C</CommandShortcut>
          </CommandItem>
          <CommandItem value="action:eof" onSelect={handleSelect}>
            <Terminal className="h-4 w-4" />
            Send EOF (Ctrl+D)
            <CommandShortcut>^D</CommandShortcut>
          </CommandItem>
          <CommandItem value="action:clear" onSelect={handleSelect}>
            <Trash2 className="h-4 w-4" />
            Clear Terminal
            <CommandShortcut>^L</CommandShortcut>
          </CommandItem>
          <CommandItem value="action:suspend" onSelect={handleSelect}>
            <Pause className="h-4 w-4" />
            Suspend (Ctrl+Z)
            <CommandShortcut>^Z</CommandShortcut>
          </CommandItem>
        </CommandGroup>

        {/* The keyboard route between the terminal and everything around it.
            The desktop header and the mobile settings panel cover the other
            two; this is the one that works without either being visible. */}
        <CommandSeparator />
        <CommandGroup heading="Go to">
          <CommandItem
            value="open:overview"
            keywords={["sessions", "windows", "panes", "machines", "choose-tree"]}
            onSelect={handleSelect}
          >
            <LayoutGrid className="h-4 w-4" />
            Overview
            <CommandShortcut>^O</CommandShortcut>
          </CommandItem>
          <CommandItem value="open:settings" onSelect={handleSelect}>
            <SlidersHorizontal className="h-4 w-4" />
            Settings
          </CommandItem>
          {paletteOpen && (
            <GraphCommand onDone={() => setPaletteOpen(false)} />
          )}
          <CommandItem value="goto:/login" onSelect={handleSelect}>
            <PlugZap className="h-4 w-4" />
            Connect another machine
          </CommandItem>
        </CommandGroup>

        {pinnedSnippets.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading="Pinned">
              {pinnedSnippets.map((snippet) => (
                <CommandItem
                  key={snippet.id}
                  value={`snippet:${snippet.command}`}
                  onSelect={handleSelect}
                >
                  <Bookmark className="h-4 w-4 text-yellow-500" />
                  <span className="flex-1">{snippet.name}</span>
                  <span className="text-xs text-muted-foreground">
                    {snippet.command}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}

        {otherSnippets.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading="Snippets">
              {otherSnippets.map((snippet) => (
                <CommandItem
                  key={snippet.id}
                  value={`snippet:${snippet.command}`}
                  onSelect={handleSelect}
                >
                  <Send className="h-4 w-4" />
                  <span className="flex-1">{snippet.name}</span>
                  <span className="text-xs text-muted-foreground">
                    {snippet.command}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}

        {history.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading="Recent">
              {history.slice(0, 10).map((cmd, i) => (
                <CommandItem
                  key={`${i}-${cmd}`}
                  value={`history:${cmd}`}
                  onSelect={handleSelect}
                >
                  <History className="h-4 w-4" />
                  {cmd}
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}
      </CommandList>
    </CommandDialog>
  );
}

/**
 * "Open git graph" for the repository of the active pane. Shown on desktop
 * only, and only once the pane folder turns out to be inside a repository.
 */
function GraphCommand({ onDone }: { onDone: () => void }) {
  const client = useRelayClient();
  const connected = useConnectionStore((s) => s.status === "connected");
  const supported = useConnectionStore((s) => s.features.has("repo:graph"));
  if (!client || !connected || !supported || isMobileViewport()) return null;
  return <GraphCommandItem client={client} onDone={onDone} />;
}

function GraphCommandItem({
  client,
  onDone,
}: {
  client: RepositoryClient;
  onDone: () => void;
}) {
  const paneId = usePaneStore((s) => s.activePaneId);
  const query = useRepositoryQuery(
    client,
    paneId ? { id: paneId, action: "context" } : null,
    0,
  );
  const root =
    query.result?.kind === "context" ? query.result.root : null;
  if (!paneId || !root) return null;
  return (
    <CommandItem
      value="open:graph"
      keywords={["git", "graph", "log", "branches", "history"]}
      onSelect={() => {
        onDone();
        useMainTabsStore.getState().openGraph({ paneId, contextPath: root });
      }}
    >
      <GitGraph className="h-4 w-4" />
      Open git graph
    </CommandItem>
  );
}
