/**
 * Command ids, titles and groups, without the code that runs them.
 *
 * Ids are stable. They live in user keybindings files, so a rename breaks
 * someone's bindings. Kept apart from `commands.ts` so the keymap, the store
 * and their tests do not load every feature store.
 */

export const COMMAND_GROUPS = [
  { id: "palette", title: "Palette" },
  { id: "workspace", title: "Workspace" },
  { id: "terminal", title: "Terminal" },
  { id: "tmux", title: "tmux" },
  { id: "dictation", title: "Dictation" },
  { id: "security", title: "Security" },
  { id: "appearance", title: "Appearance" },
] as const;

export type CommandGroup = (typeof COMMAND_GROUPS)[number]["id"];

export interface CommandInfo {
  title: string;
  group: CommandGroup;
  /**
   * Skip key repeat. Holding the key runs the command once. Set for commands
   * that flip state or create something, where a repeat would undo or flood.
   */
  toggle?: boolean;
}

export const COMMAND_INFO = {
  "palette.commands": { title: "Command palette", group: "palette", toggle: true },
  "palette.files": { title: "Find files", group: "palette", toggle: true },
  "palette.terminals": { title: "Search terminals", group: "palette", toggle: true },
  "palette.open": { title: "Open palette in a mode", group: "palette", toggle: true },

  "sidebar.toggle": { title: "Toggle sidebar", group: "workspace", toggle: true },
  "sidebar.files": { title: "Toggle files", group: "workspace", toggle: true },
  "overview.toggle": { title: "Toggle overview", group: "workspace", toggle: true },
  "settings.open": { title: "Open settings", group: "workspace", toggle: true },
  "shortcuts.open": { title: "Show keyboard shortcuts", group: "workspace", toggle: true },
  "views.close": { title: "Close current view", group: "workspace" },
  "views.closeAll": { title: "Close all views", group: "workspace", toggle: true },

  "terminal.zoomIn": { title: "Larger text, terminal or open file", group: "terminal" },
  "terminal.zoomOut": { title: "Smaller text, terminal or open file", group: "terminal" },
  "terminal.zoomReset": { title: "Reset text size", group: "terminal" },
  "terminal.search": { title: "Find in terminal", group: "terminal", toggle: true },
  "terminal.interrupt": { title: "Interrupt", group: "terminal" },
  "terminal.eof": { title: "End input", group: "terminal" },
  "terminal.clear": { title: "Clear screen", group: "terminal" },
  "terminal.suspend": { title: "Suspend process", group: "terminal" },
  "terminal.prefix": { title: "Send tmux prefix", group: "terminal" },
  "terminal.copyMode": { title: "Scroll history", group: "terminal", toggle: true },

  "tmux.newSession": { title: "New session", group: "tmux", toggle: true },
  "tmux.newWindow": { title: "New window", group: "tmux", toggle: true },
  "tmux.nextWindow": { title: "Next window", group: "tmux" },
  "tmux.previousWindow": { title: "Previous window", group: "tmux" },
  "tmux.nextPane": { title: "Next pane", group: "tmux" },
  "tmux.previousPane": { title: "Previous pane", group: "tmux" },
  "tmux.splitRight": { title: "Split pane right", group: "tmux", toggle: true },
  "tmux.splitDown": { title: "Split pane down", group: "tmux", toggle: true },
  "tmux.zoomPane": { title: "Zoom or unzoom pane", group: "tmux", toggle: true },
  "tmux.killPane": { title: "Kill pane", group: "tmux", toggle: true },
  "tmux.killWindow": { title: "Kill window", group: "tmux", toggle: true },
  "tmux.detach": { title: "Detach session", group: "tmux", toggle: true },

  "dictation.toggle": { title: "Start or stop dictation", group: "dictation", toggle: true },

  "lock.now": { title: "Lock now", group: "security", toggle: true },
  "session.disconnect": { title: "Disconnect this browser", group: "security", toggle: true },

  "theme.light": { title: "Light theme", group: "appearance" },
  "theme.dark": { title: "Dark theme", group: "appearance" },
  "theme.system": { title: "System theme", group: "appearance" },
} as const satisfies Record<string, CommandInfo>;

export type CommandId = keyof typeof COMMAND_INFO;

export const COMMAND_IDS = Object.keys(COMMAND_INFO) as CommandId[];

export function isCommandId(id: string): id is CommandId {
  return Object.hasOwn(COMMAND_INFO, id);
}
