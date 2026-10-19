import type { ClientMessage } from "@/protocol";
import {
  filesDisabled,
  isReadOnly,
  supportsStep,
  useConnectionStore,
} from "@/features/connection/connection-store";
import { useMachineStore } from "@/features/connection/machine-store";
import { getRelayClient } from "@/features/connection/use-websocket";
import { toggleDictation } from "@/features/dictation/dictation";
import { lockNow } from "@/features/lock/lock-controller";
import { disconnectDevice } from "@/features/lock/sign-out";
import { isEnrolled, isUnlocked } from "@/features/lock/unlocked";
import type { PaletteMode } from "@/features/palette/palette-key";
import { confirmAfterPalette, togglePalette } from "@/features/palette/palette-store";
import { useShortcutsDialog } from "@/features/palette/shortcuts-dialog-store";
import { usePaneStore } from "@/features/panes/pane-store";
import { zoomPane } from "@/features/panes/pane-zoom";
import { useSessionStore } from "@/features/session/session-store";
import { useSessionTreeStore } from "@/features/session/session-tree-store";
import { useSettingsStore } from "@/features/settings/settings-store";
import { noteEnteredCopyMode } from "@/features/terminal/copy-mode-belief";
import { applyFontZoom, fontZoomSurface } from "@/features/terminal/font-zoom";
import { getTerminalHandle } from "@/features/terminal/terminal-handle";
import { OVERVIEW_TAB, TERMINAL_TAB, useMainTabsStore } from "@/features/workspace/main-tabs-store";
import { useUiStore } from "@/features/workspace/ui-store";
import { activateView } from "@/features/workspace/workspace-target";
import { isMobileViewport } from "@/shared/mobile-query";
import { setThemeFromCommand } from "@/shared/theme-context";
import { COMMAND_IDS, COMMAND_INFO, type CommandId, type CommandInfo } from "./command-ids";

/**
 * What every command id does, wired to the actions the palette and the old
 * key handlers used.
 */

export interface CommandContext {
  /** `args` of the binding entry. Any JSON, so a command checks its shape. */
  args?: unknown;
  /** The key press that ran the command. Absent when the palette runs it. */
  event?: KeyboardEvent;
}

export interface Command extends CommandInfo {
  id: CommandId;
  /** Returns false when it did not handle the key, so the browser keeps it. */
  run: (ctx: CommandContext) => boolean | void;
  /** False skips the command and lets the key through. */
  enabled?: () => boolean;
}

type Behaviour = Pick<Command, "run" | "enabled">;

const PALETTE_MODES: readonly PaletteMode[] = ["commands", "files", "terminals"];

function send(message: ClientMessage): void {
  getRelayClient()?.send(message);
}

function connected(): boolean {
  return useConnectionStore.getState().status === "connected" && getRelayClient() !== null;
}

function canType(): boolean {
  return (
    connected() &&
    !isReadOnly(useConnectionStore.getState().capabilities) &&
    !!useSessionStore.getState().activeSessionId
  );
}

/** Typing is allowed and the active session is the attached tmux session. */
function inTmux(): boolean {
  if (!canType()) return false;
  const attached = useSessionTreeStore.getState().attachedSession;
  return attached !== null && attached === useSessionStore.getState().activeSessionId;
}

function severalPanes(): boolean {
  return usePaneStore.getState().panes.length > 1;
}

function canStep(): boolean {
  return supportsStep(useConnectionStore.getState().features);
}

/** The key landed in a dialog other than the palette. */
function inOtherDialog(event: KeyboardEvent | undefined): boolean {
  const target = event?.target as Element | null | undefined;
  return (
    typeof target?.closest === "function" && !!target.closest('[role="dialog"]:not([data-palette])')
  );
}

function palette(mode: PaletteMode): Behaviour {
  return {
    run: ({ event }) => {
      // Another dialog owns the keyboard. The palette itself switches modes.
      if (inOtherDialog(event)) return;
      togglePalette(mode);
    },
  };
}

function signal(message: ClientMessage): Behaviour {
  return { enabled: canType, run: () => send(message) };
}

function tmux(message: ClientMessage, enabled: () => boolean = inTmux): Behaviour {
  return { enabled, run: () => send(message) };
}

/** Ctrl with -, = or 0 sizes the focused terminal or code view. */
function zoom(step: -1 | 0 | 1): Behaviour {
  return {
    run: ({ event }) => {
      // Run from the palette there is no key target. The terminal is meant.
      const surface = event ? fontZoomSurface(event.target) : "terminal";
      // Nothing to size. The browser keeps the key for page zoom.
      if (!surface) return false;
      applyFontZoom(surface, step);
    },
  };
}

function split(direction: "h" | "v"): Behaviour {
  return {
    enabled: inTmux,
    run: () => {
      send({ type: "pane:split", direction });
      if (isMobileViewport() && useSettingsStore.getState().autoZoom) {
        usePaneStore.getState().setPendingAutoZoom(true);
      }
    },
  };
}

function closeViews(close: () => void): void {
  close();
  activateView(useMainTabsStore.getState().active);
}

const BEHAVIOUR: Record<CommandId, Behaviour> = {
  "palette.commands": palette("commands"),
  "palette.files": palette("files"),
  "palette.terminals": palette("terminals"),
  // `args.mode` picks the mode. Toggles like the commands above, so a second
  // press closes the palette again.
  "palette.open": {
    run: ({ args, event }) => {
      if (inOtherDialog(event)) return;
      const wanted = typeof args === "object" && args !== null && "mode" in args ? args.mode : null;
      const mode = PALETTE_MODES.find((entry) => entry === wanted) ?? "commands";
      togglePalette(mode);
    },
  },

  "sidebar.toggle": { run: () => useUiStore.getState().toggleSidebar() },
  "sidebar.files": {
    enabled: () => !filesDisabled(useConnectionStore.getState().capabilities),
    run: () => {
      // Desktop has no Files tab. It has a sidebar view.
      if (isMobileViewport()) useUiStore.getState().setMobileTab("files");
      else useUiStore.getState().toggleSidebarView("files");
    },
  },
  "overview.toggle": {
    run: () => {
      // The overview tab, and back to the terminal on a second press.
      const tabs = useMainTabsStore.getState();
      const mobile = isMobileViewport();
      if (tabs.active !== OVERVIEW_TAB) tabs.openOverview();
      else {
        tabs.showTerminal();
        // Focus was in the page that just went away.
        if (!mobile) requestAnimationFrame(() => getTerminalHandle()?.focus());
      }
      if (mobile) useUiStore.getState().setMobileTab("terminal");
    },
  },
  "settings.open": {
    run: () => {
      if (isMobileViewport()) useUiStore.getState().setMobileTab("settings");
      else useMainTabsStore.getState().openSettings();
    },
  },
  "shortcuts.open": { run: () => useShortcutsDialog.setState({ open: true }) },
  "views.close": {
    enabled: () => {
      const { active, tabs } = useMainTabsStore.getState();
      return active !== TERMINAL_TAB && tabs.some((tab) => tab.id === active);
    },
    run: () => {
      const tabs = useMainTabsStore.getState();
      closeViews(() => tabs.closeTab(tabs.active));
    },
  },
  "views.closeAll": {
    enabled: () => useMainTabsStore.getState().tabs.length > 0,
    run: () => closeViews(() => useMainTabsStore.getState().closeTabs("all")),
  },

  "terminal.zoomIn": zoom(1),
  "terminal.zoomOut": zoom(-1),
  "terminal.zoomReset": zoom(0),
  "terminal.search": {
    enabled: () => !!useSessionStore.getState().activeSessionId,
    run: () => useUiStore.getState().setTerminalSearchOpen(true),
  },
  "terminal.interrupt": signal({ type: "command:interrupt" }),
  "terminal.eof": signal({ type: "command:eof" }),
  "terminal.clear": signal({ type: "command:clear" }),
  "terminal.suspend": signal({ type: "command:suspend" }),
  "terminal.prefix": signal({ type: "tmux:prefix" }),
  "terminal.copyMode": {
    enabled: canType,
    run: () => {
      send({ type: "tmux:copy-mode" });
      noteEnteredCopyMode(useSessionStore.getState().activeSessionId);
    },
  },

  "tmux.newSession": {
    enabled: connected,
    run: () => {
      useMachineStore.setState({ createSession: true });
    },
  },
  "tmux.newWindow": tmux({ type: "window:create" }),
  "tmux.nextWindow": tmux({ type: "window:step", delta: 1 }, windowStepEnabled),
  "tmux.previousWindow": tmux({ type: "window:step", delta: -1 }, windowStepEnabled),
  "tmux.nextPane": tmux({ type: "pane:step", delta: 1 }, paneStepEnabled),
  "tmux.previousPane": tmux({ type: "pane:step", delta: -1 }, paneStepEnabled),
  "tmux.splitRight": split("h"),
  "tmux.splitDown": split("v"),
  "tmux.zoomPane": {
    enabled: () => inTmux() && (severalPanes() || !!usePaneStore.getState().zoomedPaneId),
    run: () => zoomPane(),
  },
  "tmux.killPane": {
    enabled: () => inTmux() && severalPanes() && !!usePaneStore.getState().activePaneId,
    run: () => {
      const id = usePaneStore.getState().activePaneId;
      if (!id) return;
      confirmAfterPalette({
        title: "Kill this pane?",
        description:
          "The pane and every process running in it are terminated. This cannot be undone.",
        label: "Kill pane",
        run: () => send({ type: "pane:kill", id }),
      });
    },
  },
  "tmux.killWindow": {
    enabled: () => inTmux() && !!usePaneStore.getState().activeWindowId,
    run: () => {
      const { activeWindowId: id, windows } = usePaneStore.getState();
      if (!id) return;
      const name = windows.find((window) => window.id === id)?.name ?? "";
      confirmAfterPalette({
        title: name ? `Kill window “${name}”?` : "Kill this window?",
        description:
          "The window, all of its panes and every process in them are terminated. This cannot be undone.",
        label: "Kill window",
        run: () => send({ type: "window:kill", id }),
      });
    },
  },
  "tmux.detach": signal({ type: "session:detach" }),

  "dictation.toggle": {
    enabled: () => useConnectionStore.getState().features.has("dictation"),
    run: () => toggleDictation(),
  },

  "lock.now": {
    enabled: () => isEnrolled() && isUnlocked(),
    run: () => lockNow("manual"),
  },
  "session.disconnect": {
    run: () =>
      confirmAfterPalette({
        title: "Disconnect this browser?",
        description:
          "The relay token is removed from this browser. You need it to sign in again. Your tmux sessions keep running.",
        label: "Disconnect",
        run: () => {
          void disconnectDevice();
        },
      }),
  },

  "theme.light": { run: () => setThemeFromCommand("light") },
  "theme.dark": { run: () => setThemeFromCommand("dark") },
  "theme.system": { run: () => setThemeFromCommand("system") },
};

function windowStepEnabled(): boolean {
  return inTmux() && usePaneStore.getState().windows.length > 1 && canStep();
}

function paneStepEnabled(): boolean {
  return inTmux() && severalPanes() && canStep();
}

const COMMANDS = new Map<string, Command>(
  COMMAND_IDS.map((id) => [id, { id, ...COMMAND_INFO[id], ...BEHAVIOUR[id] }]),
);

export function getCommand(id: string): Command | undefined {
  return COMMANDS.get(id);
}

/**
 * Run a command by id, as the palette does. True when it ran and handled
 * the action. A disabled command does nothing and returns false.
 */
export function runCommand(id: CommandId, ctx: CommandContext = {}): boolean {
  const command = COMMANDS.get(id);
  if (!command || (command.enabled && !command.enabled())) return false;
  return command.run(ctx) !== false;
}
