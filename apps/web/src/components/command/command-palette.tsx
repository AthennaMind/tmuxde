"use client";

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
} from "@repo/ui/components/ui/command";
import {
  Terminal,
  XCircle,
  Send,
  Trash2,
  Pause,
  History,
  Bookmark,
  LayoutGrid,
  PlugZap,
  Server,
  SlidersHorizontal,
} from "lucide-react";
import { useCommandStore } from "@/stores/command-store";
import { useUiStore } from "@/stores/ui-store";
import { getRelayClient } from "@/hooks/use-websocket";
import { sendCommand } from "@/lib/send-command";
import { isHostedBuild, useSession } from "@/lib/auth-client";

/**
 * The two account rows, and why they are a separate component.
 *
 * `useSession()` is an unconditional fetch. A hook cannot be called
 * conditionally, so `if (!isHostedBuild) return null` at the top of a component
 * that calls it does not prevent the call — it only prevents the render. In a
 * self-hosted build `hostedApiUrl` is null, better-auth falls back to a
 * same-origin `/api/auth/get-session`, and the terminal — the app's primary
 * surface — fired a guaranteed 404 on every single load.
 *
 * `entry-header.tsx` already spells out the rule this follows: the thing to
 * extract is the markup, never the session hook. So the hook lives here, in a
 * component that is only mounted when there is a broker to ask.
 */
function PaletteAccountItems({
  onSelect,
}: {
  onSelect: (value: string) => void;
}) {
  const { data: session, isPending } = useSession();
  const signedIn = !isPending && !!session?.user;
  const signedOut = !isPending && !session?.user;

  return (
    <>
      {signedIn && (
        <CommandItem value="goto:/dashboard" onSelect={onSelect}>
          <LayoutGrid className="h-4 w-4" />
          Your machines
        </CommandItem>
      )}
      {/* Signed out, the same slot offers the thing that would make the row
          above it exist. Never both, and never while the session is still in
          flight — an item that appears a beat late is an item someone's arrow
          key has already skipped past. */}
      {signedOut && (
        <CommandItem value="goto:/signup" onSelect={onSelect}>
          <LayoutGrid className="h-4 w-4" />
          Create an mtmux account
        </CommandItem>
      )}
    </>
  );
}

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
      if (value === "open:machines") {
        setPaletteOpen(false);
        useUiStore.getState().setMachineSwitcherOpen(true);
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
          {/* Stays in the terminal rather than navigating: switching machines
              is the common case, and the sheet does it without a page load. */}
          <CommandItem value="open:machines" onSelect={handleSelect}>
            <Server className="h-4 w-4" />
            Switch machine
          </CommandItem>
          <CommandItem value="goto:/settings" onSelect={handleSelect}>
            <SlidersHorizontal className="h-4 w-4" />
            Settings
          </CommandItem>
          {isHostedBuild && <PaletteAccountItems onSelect={handleSelect} />}
          <CommandItem value="goto:/start" onSelect={handleSelect}>
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
