import {
  AppWindow,
  ArrowLeftRight,
  Bookmark,
  ChevronsLeftRight,
  CircleStop,
  CircleX,
  Columns2,
  Eraser,
  FileJson,
  FileSearch,
  FolderTree,
  GitCommitHorizontal,
  GitCompareArrows,
  GitGraph,
  History,
  Images,
  Keyboard,
  LayoutGrid,
  LayoutList,
  LayoutTemplate,
  Lock,
  LogOut,
  Maximize2,
  Mic,
  MicOff,
  Minimize2,
  Monitor,
  Moon,
  Palette,
  PanelLeft,
  Pause,
  PenLine,
  Plus,
  Radio,
  RotateCw,
  Rows2,
  ScrollText,
  Search,
  Send,
  Settings,
  SlidersHorizontal,
  Square,
  SquareTerminal,
  StepBack,
  StepForward,
  Sun,
  TextSearch,
  Trash2,
  Unplug,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import type { ClientMessage } from "@/protocol";
import { RepositoryFileIcon } from "@/features/files/repository-file-icon";
import { useQuickOpenQuery } from "./use-quick-open-query";
import { useDictationAvailable } from "@/features/dictation/use-dictation-available";
import { getRelayClient, useRelayClient } from "@/features/connection/use-websocket";
import { useStableMediaQuery } from "@/shared/use-media-query";
import { useTheme } from "@/shared/use-theme";
import { MOBILE_MEDIA_QUERY } from "@/shared/mobile-query";
import type { CommandId } from "@/features/keybindings/command-ids";
import { runCommand } from "@/features/keybindings/commands";
import { useKeybindingsStore } from "@/features/keybindings/keybindings-store";
import { shortcutLabel } from "@/features/keybindings/shortcut-label";
import { sendCommand } from "@/features/terminal/send-command";
import { runInSession } from "@/features/session/session-target";
import { DEFAULT_TERMINAL_THEME, terminalThemes } from "@/features/terminal/terminal-themes";
import { isEnrolled, isUnlocked } from "@/features/lock/unlocked";
import { activateView, openMachineSession } from "@/features/workspace/workspace-target";
import { useCommandStore } from "@/features/terminal/command-store";
import {
  filesDisabled,
  isReadOnly,
  supportsStep,
  useConnectionStore,
} from "@/features/connection/connection-store";
import { useDictationStore } from "@/features/dictation/dictation-store";
import { useMachineStore } from "@/features/connection/machine-store";
import {
  TERMINAL_TAB,
  inGroup,
  jsonSettingsTabLabel,
  useMainTabsStore,
  type MainTab,
  type TabOrigin,
} from "@/features/workspace/main-tabs-store";
import { confirmAfterPalette, promptInPalette } from "./palette-store";
import { usePaneStore } from "@/features/panes/pane-store";
import { useSessionStore } from "@/features/session/session-store";
import { useSessionTreeStore } from "@/features/session/session-tree-store";
import {
  clampFontSize,
  getDefaultFontSize,
  useTerminalStore,
} from "@/features/terminal/terminal-store";
import { useUiStore, type SidebarView } from "@/features/workspace/ui-store";
import type { PaletteItem } from "./palette-primitives";
import { usePalette } from "./palette-context";

export interface PaletteGroup {
  id: string;
  heading: string;
  items: PaletteItem[];
}

const SCOPE_SHORT = { staged: "staged", unstaged: "diff", untracked: "new" } as const;

function join(parts: (string | undefined | null)[]): string | undefined {
  const text = parts.filter(Boolean).join(" · ");
  return text || undefined;
}

function folderName(path: string): string {
  return path.replace(/\/+$/, "").split("/").pop() || path;
}

function parentDir(path: string): string | undefined {
  const slash = path.lastIndexOf("/");
  return slash > 0 ? path.slice(0, slash) : undefined;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

export function useCanType(): boolean {
  const connected = useConnectionStore((s) => s.status === "connected");
  const readOnly = useConnectionStore((s) => isReadOnly(s.capabilities));
  const session = useSessionStore((s) => s.activeSessionId);
  return connected && !readOnly && !!session;
}

export function useWorkspaceContext(): {
  machine: string;
  session: string | null;
  folder: string | null;
} {
  const machines = useMachineStore((s) => s.machines);
  const activeMachine = useMachineStore((s) => s.activeMachine);
  const session = useSessionStore((s) => s.activeSessionId);
  const folder = usePaneStore((s) => s.panes.find((p) => p.id === s.activePaneId)?.path ?? null);
  return {
    machine: machines.find((m) => m.id === activeMachine)?.name ?? activeMachine,
    session,
    folder,
  };
}

function describeTab(
  tab: MainTab,
  origin: (tab: TabOrigin) => string | undefined,
): Pick<PaletteItem, "label" | "detail" | "icon" | "keywords"> {
  switch (tab.kind) {
    case "settings":
      return { label: "Settings", icon: <Settings />, keywords: ["preferences"] };
    case "overview":
      return {
        label: "Overview",
        icon: <LayoutGrid />,
        keywords: ["sessions", "windows", "panes"],
      };
    case "commit":
      return {
        label: tab.subject || tab.hash.slice(0, 7),
        detail: join([tab.subject ? tab.hash.slice(0, 7) : undefined, origin(tab)]),
        icon: <GitCommitHorizontal />,
        keywords: ["commit", "diff", tab.hash.slice(0, 7)],
      };
    case "graph":
      return {
        label: "Graph",
        detail: join([folderName(tab.contextPath), origin(tab)]),
        icon: <GitGraph />,
        keywords: ["git", "log", "branches"],
      };
    case "changes":
      return {
        label: "Current changes",
        detail: join([folderName(tab.contextPath), origin(tab)]),
        icon: <GitCompareArrows />,
        keywords: ["git", "diff", "status"],
      };
    case "json-settings":
      return {
        label: jsonSettingsTabLabel(tab.name),
        icon: <FileJson />,
        keywords: ["settings", "keybindings", "json"],
      };
    default:
      return {
        label: tab.path.split("/").pop() || tab.path,
        detail: join([
          tab.scope ? SCOPE_SHORT[tab.scope] : undefined,
          parentDir(tab.path),
          origin(tab),
        ]),
        icon: <RepositoryFileIcon path={tab.path} />,
        keywords: ["file", tab.path],
      };
  }
}

/**
 * Everything the app can do, read live from the stores.
 *
 * Built on every render while the palette is open. A few dozen items is
 * cheaper than keeping a memo in step with twenty store fields.
 */
export function usePaletteCommands(query: string): PaletteGroup[] {
  const { finish, setMode } = usePalette();
  const mobile = useStableMediaQuery(MOBILE_MEDIA_QUERY);
  const status = useConnectionStore((s) => s.status);
  const capabilities = useConnectionStore((s) => s.capabilities);
  const features = useConnectionStore((s) => s.features);
  const session = useSessionStore((s) => s.activeSessionId);
  const localSessions = useSessionStore((s) => s.sessions);
  const attached = useSessionTreeStore((s) => s.attachedSession);
  const windows = usePaneStore((s) => s.windows);
  const panes = usePaneStore((s) => s.panes);
  const activeWindowId = usePaneStore((s) => s.activeWindowId);
  const activePaneId = usePaneStore((s) => s.activePaneId);
  const zoomedPaneId = usePaneStore((s) => s.zoomedPaneId);
  const machines = useMachineStore((s) => s.machines);
  const inventory = useMachineStore((s) => s.inventory);
  const terminals = useMachineStore((s) => s.terminals);
  const activeMachine = useMachineStore((s) => s.activeMachine);
  const tabs = useMainTabsStore((s) => s.tabs);
  const activeTab = useMainTabsStore((s) => s.active);
  const sidebarCollapsed = useUiStore((s) => s.sidebarCollapsed);
  const { theme, setTheme } = useTheme();
  const themeName = useTerminalStore((s) => s.themeName);
  const fontSize = useTerminalStore((s) => s.fontSize);
  const dictationAvailable = useDictationAvailable();
  const dictating = useDictationStore((s) => s.status === "starting" || s.status === "listening");
  const history = useCommandStore((s) => s.history);
  const snippets = useCommandStore((s) => s.snippets);
  const client = useRelayClient();
  const keymap = useKeybindingsStore((s) => s.keymap);

  const connected = status === "connected" && client !== null;
  const noFiles = filesDisabled(capabilities);
  const canType = connected && !isReadOnly(capabilities) && !!session;
  const inTmux = canType && attached !== null && attached === session;
  const context = useQuickOpenQuery(
    client,
    connected && !mobile && !noFiles && activePaneId
      ? { id: activePaneId, action: "context" }
      : null,
    0,
  );
  const root = context.result?.kind === "context" ? context.result.root : null;
  const many = machines.length > 1;
  const machineName = (id: string) => machines.find((m) => m.id === id)?.name ?? id;
  const origin = (tab: TabOrigin) => (many ? machineName(tab.machineId ?? "local") : undefined);
  const send = (message: ClientMessage) => getRelayClient()?.send(message);
  const sendAll = (messages: ClientMessage[]) => {
    for (const message of messages) send(message);
  };
  const terminal = (messages: ClientMessage[]) => () => {
    sendAll(messages);
    finish("terminal");
  };
  // Hints come from the keymap, so they follow the platform and user bindings.
  const hint = (id: CommandId) => {
    const label = shortcutLabel(id, keymap);
    return label ? [label] : undefined;
  };
  // Static items with a registered command run it, then close the palette.
  const invoke = (id: CommandId, focus?: "terminal") => () => {
    runCommand(id);
    finish(focus);
  };
  const showSidebar = (view: SidebarView) => () => {
    useUiStore.getState().showSidebarView(view);
    finish();
  };
  const groups: PaletteGroup[] = [];
  const add = (id: string, heading: string, items: PaletteItem[]) => {
    if (items.length) groups.push({ id, heading, items });
  };

  // Open views: terminals and every tab beside them.
  const views: PaletteItem[] = terminals.map((entry) => ({
    id: `view:terminal:${entry.machineId}:${entry.sessionName}`,
    label: entry.sessionName,
    detail: many ? machineName(entry.machineId) : undefined,
    keywords: ["terminal", "session", machineName(entry.machineId)],
    icon: <SquareTerminal />,
    mono: true,
    current:
      activeTab === TERMINAL_TAB &&
      entry.machineId === activeMachine &&
      entry.sessionName === session,
    run: () => {
      openMachineSession(entry.machineId, entry.sessionName);
      finish("terminal");
    },
  }));
  for (const tab of tabs) {
    views.push({
      id: `view:${tab.id}`,
      ...describeTab(tab, origin),
      current: activeTab === tab.id,
      run: () => {
        activateView(tab.id);
        finish();
      },
    });
  }
  add("views", "Open views", views);

  // Sessions on every online machine, then windows and panes of this one.
  const sessions: PaletteItem[] = [];
  for (const machine of machines) {
    if (!machine.online) continue;
    const list =
      inventory[machine.id]?.sessions ?? (machine.id === activeMachine ? localSessions : []);
    for (const entry of list) {
      sessions.push({
        id: `session:${machine.id}:${entry.name}`,
        label: entry.name,
        detail: join([many ? machine.name : undefined, plural(entry.windows, "window")]),
        keywords: ["session", "switch", "attach", machine.name],
        icon: <LayoutList />,
        mono: true,
        current: machine.id === activeMachine && entry.name === session,
        run: () => {
          openMachineSession(machine.id, entry.name);
          finish("terminal");
        },
      });
    }
  }
  if (connected) {
    sessions.push({
      id: "tmux:new-session",
      label: "New session…",
      keywords: ["create", "start", "tmux"],
      icon: <Plus />,
      run: invoke("tmux.newSession"),
    });
  }
  add("sessions", "Sessions", sessions);

  if (inTmux && attached && windows.length > 1) {
    add(
      "windows",
      "Windows",
      windows.map((window) => ({
        id: `window:${window.id}`,
        label: window.name,
        detail: join([`window ${window.index}`, plural(window.paneCount, "pane")]),
        keywords: ["window", "switch", String(window.index)],
        icon: <AppWindow />,
        mono: true,
        current: window.active,
        run: () => {
          runInSession(attached, [{ type: "window:select", id: window.id }]);
          finish("terminal");
        },
      })),
    );
  }
  const windowPanes = panes.filter((pane) => pane.windowId === activeWindowId);
  if (inTmux && attached && windowPanes.length > 1) {
    add(
      "panes",
      "Panes",
      windowPanes.map((pane) => ({
        id: `pane:${pane.id}`,
        label: pane.command || `Pane ${pane.index}`,
        detail: join([`pane ${pane.index}`, pane.path]),
        keywords: ["pane", "switch", String(pane.index)],
        icon: <Square />,
        mono: true,
        current: pane.id === activePaneId,
        run: () => {
          runInSession(attached, [{ type: "pane:select", id: pane.id }]);
          finish("terminal");
        },
      })),
    );
  }

  // Go to.
  const navigate: PaletteItem[] = [
    {
      id: "go:overview",
      label: "Overview",
      keywords: ["sessions", "windows", "panes", "machines"],
      icon: <LayoutGrid />,
      shortcut: hint("overview.toggle"),
      run: () => {
        useMainTabsStore.getState().openOverview();
        if (mobile) useUiStore.getState().setMobileTab("terminal");
        finish();
      },
    },
    {
      id: "go:settings",
      label: "Settings",
      keywords: ["preferences", "theme", "font"],
      icon: <SlidersHorizontal />,
      run: invoke("settings.open"),
    },
    {
      id: "go:sessions",
      label: "Sessions list",
      keywords: ["sidebar", "tree", "machines"],
      icon: <LayoutList />,
      run: mobile
        ? () => {
            useUiStore.getState().setMobileTab("sessions");
            finish();
          }
        : showSidebar("sessions"),
    },
  ];
  if (!noFiles) {
    navigate.push({
      id: "go:files",
      label: "Files",
      keywords: ["sidebar", "tree", "folder"],
      icon: <FolderTree />,
      shortcut: hint("sidebar.files"),
      run: mobile
        ? () => {
            useUiStore.getState().setMobileTab("files");
            finish();
          }
        : showSidebar("files"),
    });
    navigate.push({
      id: "go:find-files",
      label: "Find files",
      keywords: ["quick open", "search", "jump"],
      icon: <FileSearch />,
      shortcut: hint("palette.files"),
      run: () => setMode("files"),
    });
  }
  if (!mobile && !noFiles) {
    navigate.push({
      id: "go:changes",
      label: "Changes",
      keywords: ["git", "status", "diff", "sidebar"],
      icon: <GitCompareArrows />,
      run: showSidebar("changes"),
    });
    navigate.push({
      id: "go:history",
      label: "History",
      keywords: ["git", "log", "commits", "sidebar"],
      icon: <History />,
      run: showSidebar("history"),
    });
  }
  if (!mobile) {
    navigate.push({
      id: "go:photos",
      label: "Photos",
      keywords: ["images", "screenshots", "sidebar"],
      icon: <Images />,
      run: showSidebar("photos"),
    });
    navigate.push({
      id: "go:sidebar",
      label: sidebarCollapsed ? "Show sidebar" : "Hide sidebar",
      keywords: ["toggle", "panel", "collapse"],
      icon: <PanelLeft />,
      shortcut: hint("sidebar.toggle"),
      run: invoke("sidebar.toggle"),
    });
    if (root && activePaneId && features.has("repo:graph")) {
      navigate.push({
        id: "go:graph",
        label: "Open git graph",
        detail: folderName(root),
        keywords: ["git", "log", "branches", "history"],
        icon: <GitGraph />,
        run: () => {
          useMainTabsStore.getState().openGraph({ paneId: activePaneId, contextPath: root });
          finish();
        },
      });
      navigate.push({
        id: "go:current-changes",
        label: "Open current changes",
        detail: folderName(root),
        keywords: ["git", "diff", "status", "working tree"],
        icon: <GitCompareArrows />,
        run: () => {
          useMainTabsStore.getState().openChanges({ paneId: activePaneId, contextPath: root });
          finish();
        },
      });
    }
  }
  navigate.push({
    id: "go:search-terminals",
    label: "Search terminals",
    keywords: ["history", "output", "all machines", "grep"],
    icon: <TextSearch />,
    shortcut: hint("palette.terminals"),
    run: () => setMode("terminals"),
  });
  if (session) {
    navigate.push({
      id: "go:find",
      label: "Find in terminal",
      keywords: ["search", "scrollback"],
      icon: <Search />,
      shortcut: hint("terminal.search"),
      run: invoke("terminal.search"),
    });
  }
  navigate.push({
    id: "go:shortcuts",
    label: "Keyboard shortcuts",
    keywords: ["help", "keys"],
    icon: <Keyboard />,
    shortcut: hint("shortcuts.open"),
    run: invoke("shortcuts.open"),
  });
  add("navigate", "Go to", navigate);

  // Terminal signals and tmux keys.
  if (canType) {
    const items: PaletteItem[] = [
      {
        id: "term:interrupt",
        label: "Interrupt",
        detail: "Ctrl+C to the running process",
        icon: <CircleX />,
        shortcut: hint("terminal.interrupt"),
        destructive: true,
        run: invoke("terminal.interrupt", "terminal"),
      },
      {
        id: "term:eof",
        label: "End input",
        detail: "Ctrl+D",
        icon: <CircleStop />,
        shortcut: hint("terminal.eof"),
        run: invoke("terminal.eof", "terminal"),
      },
      {
        id: "term:clear",
        label: "Clear screen",
        detail: "Ctrl+L",
        icon: <Eraser />,
        shortcut: hint("terminal.clear"),
        run: invoke("terminal.clear", "terminal"),
      },
      {
        id: "term:suspend",
        label: "Suspend process",
        detail: "Ctrl+Z",
        icon: <Pause />,
        shortcut: hint("terminal.suspend"),
        run: invoke("terminal.suspend", "terminal"),
      },
      {
        id: "term:prefix",
        label: "Send tmux prefix",
        detail: "Then press a tmux key",
        keywords: ["ctrl+b"],
        icon: <Radio />,
        shortcut: hint("terminal.prefix"),
        run: invoke("terminal.prefix", "terminal"),
      },
      {
        id: "term:copy-mode",
        label: "Scroll history",
        detail: "tmux copy mode",
        keywords: ["scrollback", "copy mode"],
        icon: <ScrollText />,
        shortcut: hint("terminal.copyMode"),
        run: invoke("terminal.copyMode", "terminal"),
      },
      {
        id: "term:detach",
        label: "Detach session",
        keywords: ["leave", "disconnect tmux"],
        icon: <LogOut />,
        shortcut: hint("tmux.detach"),
        run: invoke("tmux.detach", "terminal"),
      },
    ];
    if (dictationAvailable) {
      items.push({
        id: "term:dictation",
        label: dictating ? "Stop dictation" : "Start dictation",
        keywords: ["voice", "speech", "microphone"],
        icon: dictating ? <MicOff /> : <Mic />,
        shortcut: hint("dictation.toggle"),
        // Dictation types where focus is. Wait for the terminal to take it back.
        run: () => {
          finish("terminal");
          requestAnimationFrame(() => requestAnimationFrame(() => runCommand("dictation.toggle")));
        },
      });
    }
    if (mobile) {
      items.push({
        id: "term:draft",
        label: "Draft command",
        detail: "Multi line editor",
        keywords: ["compose", "write"],
        icon: <PenLine />,
        run: () => {
          useUiStore.getState().openComposer();
          finish();
        },
      });
    }
    add("terminal", "Terminal", items);
  }

  // Panes, windows and sessions of the attached session.
  if (inTmux && session) {
    const several = panes.length > 1;
    const step = supportsStep(features);
    const windowName = windows.find((window) => window.id === activeWindowId)?.name ?? "";
    const items: PaletteItem[] = [
      {
        id: "tmux:split-right",
        label: "Split pane right",
        keywords: ["horizontal", "vertical split", "new pane"],
        icon: <Columns2 />,
        shortcut: hint("tmux.splitRight"),
        run: invoke("tmux.splitRight", "terminal"),
      },
      {
        id: "tmux:split-down",
        label: "Split pane down",
        keywords: ["vertical", "horizontal split", "new pane"],
        icon: <Rows2 />,
        shortcut: hint("tmux.splitDown"),
        run: invoke("tmux.splitDown", "terminal"),
      },
    ];
    if (several || zoomedPaneId) {
      items.push({
        id: "tmux:zoom",
        label: zoomedPaneId ? "Unzoom pane" : "Zoom pane",
        keywords: ["maximize", "focus", "full"],
        icon: zoomedPaneId ? <Minimize2 /> : <Maximize2 />,
        shortcut: hint("tmux.zoomPane"),
        run: invoke("tmux.zoomPane", "terminal"),
      });
    }
    if (several && step) {
      items.push({
        id: "tmux:next-pane",
        label: "Next pane",
        keywords: ["focus", "cycle"],
        icon: <StepForward />,
        shortcut: hint("tmux.nextPane"),
        run: invoke("tmux.nextPane", "terminal"),
      });
      items.push({
        id: "tmux:previous-pane",
        label: "Previous pane",
        keywords: ["focus", "cycle"],
        icon: <StepBack />,
        shortcut: hint("tmux.previousPane"),
        run: invoke("tmux.previousPane", "terminal"),
      });
    }
    if (several && activePaneId) {
      items.push({
        id: "tmux:swap",
        label: "Swap pane down",
        keywords: ["move", "reorder"],
        icon: <ArrowLeftRight />,
        run: terminal([{ type: "pane:swap", id: activePaneId, direction: "D" }]),
      });
      items.push({
        id: "tmux:rotate",
        label: "Rotate panes",
        keywords: ["layout", "cycle"],
        icon: <RotateCw />,
        run: terminal([{ type: "layout:rotate" }]),
      });
      items.push({
        id: "tmux:tiled",
        label: "Tile panes",
        keywords: ["layout", "grid", "even"],
        icon: <LayoutTemplate />,
        run: terminal([{ type: "window:layout", preset: "tiled" }]),
      });
      items.push({
        id: "tmux:main-vertical",
        label: "Main pane left",
        keywords: ["layout", "main-vertical"],
        icon: <ChevronsLeftRight />,
        run: terminal([{ type: "window:layout", preset: "main-vertical" }]),
      });
    }
    items.push({
      id: "tmux:new-window",
      label: "New window",
      keywords: ["tab", "create"],
      icon: <Plus />,
      shortcut: hint("tmux.newWindow"),
      run: invoke("tmux.newWindow", "terminal"),
    });
    if (activeWindowId) {
      items.push({
        id: "tmux:rename-window",
        label: "Rename window…",
        detail: windowName,
        keywords: ["name", "title"],
        icon: <PenLine />,
        run: () =>
          promptInPalette({
            label: "Rename window",
            placeholder: "Window name",
            hint: `New name for window ${windowName || activeWindowId}. Press Enter to apply.`,
            initial: windowName,
            submit: (name) => send({ type: "window:rename", id: activeWindowId, name }),
          }),
      });
    }
    if (windows.length > 1 && step) {
      items.push({
        id: "tmux:next-window",
        label: "Next window",
        keywords: ["cycle", "switch"],
        icon: <StepForward />,
        shortcut: hint("tmux.nextWindow"),
        run: invoke("tmux.nextWindow", "terminal"),
      });
      items.push({
        id: "tmux:previous-window",
        label: "Previous window",
        keywords: ["cycle", "switch"],
        icon: <StepBack />,
        shortcut: hint("tmux.previousWindow"),
        run: invoke("tmux.previousWindow", "terminal"),
      });
    }
    if (several && activePaneId) {
      items.push({
        id: "tmux:kill-pane",
        label: "Kill pane…",
        keywords: ["close", "terminate"],
        icon: <Trash2 />,
        destructive: true,
        shortcut: hint("tmux.killPane"),
        // The confirmation closes the palette itself.
        run: () => runCommand("tmux.killPane"),
      });
    }
    if (activeWindowId) {
      items.push({
        id: "tmux:kill-window",
        label: "Kill window…",
        detail: windowName,
        keywords: ["close", "terminate"],
        icon: <Trash2 />,
        destructive: true,
        shortcut: hint("tmux.killWindow"),
        // The confirmation closes the palette itself.
        run: () => runCommand("tmux.killWindow"),
      });
    }
    items.push({
      id: "tmux:rename-session",
      label: "Rename session…",
      detail: session,
      keywords: ["name"],
      icon: <PenLine />,
      run: () =>
        promptInPalette({
          label: "Rename session",
          placeholder: "Session name",
          hint: `New name for session ${session}. Press Enter to apply.`,
          initial: session,
          submit: (newName) => {
            if (newName !== session) send({ type: "session:rename", oldName: session, newName });
          },
        }),
    });
    items.push({
      id: "tmux:kill-session",
      label: "Kill session…",
      detail: session,
      keywords: ["close", "terminate", "end"],
      icon: <Trash2 />,
      destructive: true,
      run: () =>
        confirmAfterPalette({
          title: `Kill session “${session}”?`,
          description:
            "Every window, pane and process in the session is terminated. This cannot be undone.",
          label: "Kill session",
          run: () => send({ type: "session:kill", name: session }),
        }),
    });
    add("tmux", "Panes and windows", items);
  }

  // Managing the tab strip.
  const manage: PaletteItem[] = [];
  const has = (group: "all" | "files" | "diffs") => tabs.some((tab) => inGroup(tab, group));
  if (activeTab !== TERMINAL_TAB && tabs.some((tab) => tab.id === activeTab)) {
    manage.push({
      id: "views:close",
      label: "Close current view",
      keywords: ["tab", "close"],
      icon: <CircleX />,
      shortcut: hint("views.close"),
      run: invoke("views.close"),
    });
  }
  if (tabs.length)
    manage.push({
      id: "views:close-all",
      label: "Close all views",
      keywords: ["tabs"],
      icon: <CircleX />,
      shortcut: hint("views.closeAll"),
      run: invoke("views.closeAll"),
    });
  if (has("files"))
    manage.push({
      id: "views:close-files",
      label: "Close files",
      keywords: ["tabs"],
      icon: <CircleX />,
      run: () => {
        useMainTabsStore.getState().closeTabs("files");
        activateView(useMainTabsStore.getState().active);
        finish();
      },
    });
  if (has("diffs"))
    manage.push({
      id: "views:close-diffs",
      label: "Close diffs",
      keywords: ["tabs", "commits", "changes"],
      icon: <CircleX />,
      run: () => {
        useMainTabsStore.getState().closeTabs("diffs");
        activateView(useMainTabsStore.getState().active);
        finish();
      },
    });
  add("manage", "Views", manage);

  // Appearance.
  const maxFont = clampFontSize(Number.MAX_SAFE_INTEGER);
  add("appearance", "Appearance", [
    {
      id: "theme:light",
      label: "Light theme",
      keywords: ["appearance", "mode"],
      icon: <Sun />,
      current: theme === "light",
      shortcut: hint("theme.light"),
      run: () => {
        setTheme("light");
        finish();
      },
    },
    {
      id: "theme:dark",
      label: "Dark theme",
      keywords: ["appearance", "mode"],
      icon: <Moon />,
      current: theme === "dark",
      shortcut: hint("theme.dark"),
      run: () => {
        setTheme("dark");
        finish();
      },
    },
    {
      id: "theme:system",
      label: "System theme",
      keywords: ["appearance", "mode", "auto"],
      icon: <Monitor />,
      current: theme === "system",
      shortcut: hint("theme.system"),
      run: () => {
        setTheme("system");
        finish();
      },
    },
    ...(fontSize < maxFont
      ? [
          {
            id: "text:larger",
            label: "Larger terminal text",
            detail: `${fontSize}px`,
            keywords: ["font", "zoom", "size"],
            icon: <ZoomIn />,
            shortcut: hint("terminal.zoomIn"),
            run: () => {
              useTerminalStore.getState().setFontSize(clampFontSize(fontSize + 1));
              finish("terminal");
            },
          },
        ]
      : []),
    ...(fontSize > 8
      ? [
          {
            id: "text:smaller",
            label: "Smaller terminal text",
            detail: `${fontSize}px`,
            keywords: ["font", "zoom", "size"],
            icon: <ZoomOut />,
            shortcut: hint("terminal.zoomOut"),
            run: () => {
              useTerminalStore.getState().setFontSize(clampFontSize(fontSize - 1));
              finish("terminal");
            },
          },
        ]
      : []),
    {
      id: "text:reset",
      label: "Reset text size",
      keywords: ["font", "zoom", "default"],
      icon: <ZoomOut />,
      shortcut: hint("terminal.zoomReset"),
      run: () => {
        useTerminalStore.getState().setFontSize(getDefaultFontSize());
        finish("terminal");
      },
    },
  ]);
  add(
    "terminal-theme",
    "Terminal theme",
    [
      { key: DEFAULT_TERMINAL_THEME, name: "Match app" },
      ...Object.entries(terminalThemes).map(([key, entry]) => ({ key, name: entry.name })),
    ].map(({ key, name }) => ({
      id: `terminal-theme:${key}`,
      label: name,
      keywords: ["terminal theme", "colors", "scheme"],
      icon: <Palette />,
      current: themeName === key,
      run: () => {
        useTerminalStore.getState().setThemeName(key);
        finish();
      },
    })),
  );

  // Lock and sign out.
  const security: PaletteItem[] = [];
  if (isEnrolled() && isUnlocked()) {
    security.push({
      id: "lock",
      label: "Lock now",
      keywords: ["pin", "secure", "screen"],
      icon: <Lock />,
      shortcut: hint("lock.now"),
      run: invoke("lock.now"),
    });
  }
  security.push({
    id: "disconnect",
    label: "Disconnect this browser…",
    keywords: ["sign out", "log out", "token"],
    icon: <Unplug />,
    shortcut: hint("session.disconnect"),
    // The confirmation closes the palette itself.
    run: () => runCommand("session.disconnect"),
  });
  add("security", "Security", security);

  // Saved and recent shell commands.
  if (canType) {
    const runShell = (command: string) => () => {
      if (sendCommand(command)) finish("terminal");
    };
    const sorted = [...snippets].sort((a, b) => Number(b.pinned) - Number(a.pinned));
    add(
      "snippets",
      "Snippets",
      sorted.map((snippet) => ({
        id: `snippet:${snippet.id}`,
        label: snippet.name,
        detail: snippet.command,
        keywords: ["snippet", snippet.command],
        icon: snippet.pinned ? <Bookmark /> : <Send />,
        run: runShell(snippet.command),
      })),
    );
    add(
      "history",
      "Recent commands",
      (query ? history : history.slice(0, 8)).map((command, index) => ({
        id: `history:${index}:${command}`,
        label: command,
        keywords: ["history", "recent"],
        icon: <History />,
        mono: true,
        run: runShell(command),
      })),
    );
  }

  return groups;
}
